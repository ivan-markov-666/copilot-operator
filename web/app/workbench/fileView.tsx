'use client';

/**
 * A file, read-only, with line numbers: of the open project folder as it is on disk (no session), or of a session's
 * repository at its branch or at a task's commit.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

type Shown = { path: string; label: string; text: string | null; binary: boolean; tooLarge: boolean };

export function FileView({ sessionId, path, taskId }: { sessionId: string; path: string; taskId?: string }) {
  const { t } = useT();
  const [file, setFile] = useState<Shown | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    setErr('');
    const read = (): Promise<Shown> =>
      sessionId
        ? api.repoFile(sessionId, path, taskId)
        : api.workspaceFile(path).then((f) => ({ ...f, label: '' }));
    read()
      .then((f) => alive && setFile(f))
      .catch((e: unknown) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [sessionId, path, taskId, t]);
  if (err) return <p className="err small">{err}</p>;
  if (!file) return <p className="muted small">{t('wb.loading')}</p>;
  const lines = (file.text ?? '').split('\n');
  return (
    <div className="wb-file">
      <p className="muted small">{sessionId ? t('wb.fileAt', { path: file.path, ref: file.label }) : t('wb.fileOnDisk', { path: file.path })}</p>
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
