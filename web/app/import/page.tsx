'use client';

/**
 * Importing a plan somebody else's chat model wrote.
 *
 * The page is three steps in the order they actually happen, and it refuses to collapse them:
 * take the brief away, bring an answer back, then read what was created and start it yourself.
 * The last step is the point of the whole thing. An import that ran what it created would put
 * a chat model's decisions straight onto a real machine with nobody having read them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type PlanCheck, type PlanImport } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export default function ImportPage() {
  const { t, locale } = useT();
  const fmtTime = useFmtTime();

  // Step 1: the brief. There is nothing to configure — see the panel's own explanation.
  const [brief, setBrief] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const [briefErr, setBriefErr] = useState('');

  // Step 2: the answer.
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [check, setCheck] = useState<PlanCheck | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'import'>('');
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Step 3: what was created.
  const [imported, setImported] = useState<Extract<PlanImport, { ok: true }> | null>(null);

  // One brief per language, fetched when the language changes. Nothing else varies: what used
  // to be chosen here is now something the brief makes the chat model ask about.
  useEffect(() => {
    let cancelled = false;
    api
      .planBrief(locale)
      .then((r) => {
        if (!cancelled) {
          setBrief(r.text);
          setBriefErr('');
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setBriefErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const copy = useCallback(
    async (what: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(what);
        window.setTimeout(() => setCopied(''), 2500);
      } catch {
        setErr(t('plan.copyFailed'));
      }
    },
    [t],
  );

  const readFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        setErr(t('plan.fileTooBig', { size: `${Math.round(file.size / 1024)} KB` }));
        return;
      }
      try {
        setText(await file.text());
        setCheck(null);
        setImported(null);
        setErr('');
      } catch (e) {
        setErr(t('plan.fileError', { reason: (e as Error).message }));
      }
    },
    [t],
  );

  const runCheck = async () => {
    setBusy('check');
    setErr('');
    try {
      setCheck(await api.checkPlan(text));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const runImport = async () => {
    // The same plan pasted twice is the mistake this page invites, so it is named before it
    // happens rather than found afterwards in a list of look-alike sessions.
    const known = check && !check.ok ? [] : (check?.duplicates ?? []);
    if (known.length > 0) {
      const names = known.map((d) => `• ${d.name} (${d.tasks})`).join('\n');
      if (!window.confirm(t('plan.duplicateConfirm', { names }))) return;
    }

    setBusy('import');
    setErr('');
    try {
      const result = await api.importPlan(text);
      if (result.ok) {
        setImported(result);
        setCheck({ ok: true, warnings: result.result.warnings, summary: result.summary, duplicates: result.duplicates });
        // Emptying the box is what actually stops a second copy: a warning under a full
        // textarea is one stray click away from being ignored.
        setText('');
      } else {
        setImported(null);
        setCheck(result.check);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const issues = check && !check.ok ? check.issues : [];
  const issueText = issues.map((i) => (i.path ? `- ${i.path}: ${i.message}` : `- ${i.message}`)).join('\n');

  return (
    <>
      <div className="panel">
        <h2>{t('plan.title')}</h2>
        <p className="muted small">{t('plan.intro')}</p>
      </div>

      <div className="panel">
        <h2>{t('plan.step1')}</h2>
        <p className="muted small">{t('plan.step1Hint')}</p>

        <h3>{t('plan.briefAsks')}</h3>
        <p className="why">{t('plan.briefAsksWhy')}</p>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void copy('brief', brief)} disabled={!brief}>
            {t('plan.copyBrief')}
          </button>
          <button className="quiet" onClick={() => setBriefOpen((v) => !v)}>
            {briefOpen ? t('plan.hideBrief') : t('plan.showBrief')}
          </button>
          {copied === 'brief' && <span className="badge done">{t('plan.copied')}</span>}
          <span className="muted small">{t('plan.briefLang')}</span>
        </div>
        {briefErr && <div className="err">{briefErr}</div>}
        {briefOpen && <textarea readOnly value={brief} style={{ minHeight: 380, marginTop: 10 }} />}
      </div>

      <div className="panel">
        <h2>{t('plan.step2')}</h2>
        <p className="muted small">{t('plan.step2Hint')}</p>

        <div
          className={`dropzone${dragging ? ' active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void readFile(file);
          }}
        >
          <textarea
            className="grow"
            placeholder={t('plan.placeholder')}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCheck(null);
              setImported(null);
            }}
            style={{ minHeight: 220, width: '100%' }}
          />
          <p className="muted small">{dragging ? t('plan.dropActive') : t('plan.drop')}</p>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => fileInput.current?.click()}>{t('plan.browse')}</button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
              e.target.value = '';
            }}
          />
          <button onClick={() => void runCheck()} disabled={!text.trim() || busy !== ''}>
            {busy === 'check' ? t('plan.checking') : t('plan.check')}
          </button>
          <button className="primary" onClick={() => void runImport()} disabled={!text.trim() || busy !== ''}>
            {busy === 'import' ? t('plan.importing') : t('plan.import')}
          </button>
          <button
            className="quiet"
            onClick={() => {
              setText('');
              setCheck(null);
              setImported(null);
              setErr('');
            }}
            disabled={!text && !check}
          >
            {t('plan.clear')}
          </button>
        </div>
        {err && <div className="err">{err}</div>}
        {imported && text.trim() === '' && <p className="why">{t('plan.cleared')}</p>}
      </div>

      {check && !check.ok && (
        <div className="panel">
          <div className="notice">
            <strong>{t('plan.invalid')}</strong>
          </div>
          <h3>{t('plan.issues')}</h3>
          <p className="muted small">{t('plan.issuesHint')}</p>
          <pre>{issueText}</pre>
          <div className="row">
            <button onClick={() => void copy('issues', issueText)}>{t('plan.copyIssues')}</button>
            {copied === 'issues' && <span className="badge done">{t('plan.copied')}</span>}
          </div>
        </div>
      )}

      {(check?.duplicates.length ?? 0) > 0 && (
        <div className="panel">
          <div className="notice caution">
            <strong>{t('plan.duplicates')}</strong>
            <ul>
              {(check?.duplicates ?? []).map((d) => (
                <li key={d.sessionId}>
                  <Link href={`/sessions/${d.sessionId}`}>
                    {t('plan.duplicateRow', { name: d.name, tasks: d.tasks, when: fmtTime(d.createdAt) })}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <p className="muted small">{t('plan.duplicatesHint')}</p>
        </div>
      )}

      {check?.ok && (
        <div className="panel">
          <div className="notice calm">
            <strong>
              {imported
                ? t('plan.imported', { sessions: imported.result.sessions.length, tasks: imported.result.taskCount })
                : t('plan.valid', { sessions: check.summary.sessions.length, tasks: check.summary.taskCount })}
            </strong>
          </div>

          {check.summary.plan && <p>{check.summary.plan}</p>}
          <p className="muted small">
            {t('plan.col.planFail')}:{' '}
            {check.summary.onFailure === 'continue' ? t('batch.independent') : t('batch.chain')}
          </p>

          <h3>{t('plan.preview')}</h3>
          <table>
            <thead>
              <tr>
                <th>{t('plan.col.session')}</th>
                <th>{t('plan.col.tasks')}</th>
                <th>{t('plan.col.chain')}</th>
                <th>{t('plan.col.repo')}</th>
              </tr>
            </thead>
            <tbody>
              {check.summary.sessions.map((s, i) => {
                const created = imported?.result.sessions[i];
                return (
                  <tr key={`${s.name}-${i}`}>
                    <td>{created ? <Link href={`/sessions/${created.id}`}>{s.name}</Link> : s.name}</td>
                    <td className="small">
                      {s.tasks.length}
                      <div className="muted small">{s.tasks.join(', ')}</div>
                    </td>
                    <td className="small">{s.onFailure === 'continue' ? t('chain.continue') : t('chain.stop')}</td>
                    <td className="small muted">{s.repoDir || t('plan.noRepo')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {check.summary.notes && (
            <>
              <h3>{t('plan.notes')}</h3>
              <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                {check.summary.notes}
              </p>
            </>
          )}

          {check.warnings.length > 0 && (
            <div className="notice caution">
              <strong>{t('plan.warnings')}</strong>
              <ul>
                {check.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {imported && (
        <div className="panel">
          <h2>{t('plan.step3')}</h2>
          <p className="muted small">{t('plan.step3Hint')}</p>
          <div className="row">
            <Link
              href={`/?run=${encodeURIComponent(imported.result.sessions.map((x) => x.id).join(','))}&fail=${
                imported.summary.onFailure
              }`}
            >
              <button className="primary">{t('plan.runThese')}</button>
            </Link>
            <Link href="/">
              <button>{t('plan.toSessions')}</button>
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
