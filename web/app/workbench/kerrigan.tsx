'use client';

/**
 * Kerrigan, beside the work (operator's request, 2026-10-14: "the user tells Kerrigan what happened and she proposes
 * how to go on"). Two steps, both plain text so they work with any chat she is in: what happened — the tasks of
 * this task, this session or all of them, how each ended and why, and what the operator writes here — copied or
 * saved for her; then her answer pasted back, each change said in words, and applied when the operator agrees.
 * Nothing runs by itself after that: the run is started from the session, as always.
 */
import { useState } from 'react';
import Link from 'next/link';
import { api, type ChangesCheck, type Session, type Task } from '../../lib/api';
import { useT } from '../../lib/i18n';

type Scope = 'task' | 'session' | 'all';

export function Kerrigan({ session, task, sessions, onChange }: { session?: Session; task?: Task; sessions: Session[]; onChange: () => void }) {
  const { t } = useT();
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<Scope>(task ? 'task' : session ? 'session' : 'all');
  const [said, setSaid] = useState('');
  const [answer, setAnswer] = useState('');
  const [check, setCheck] = useState<ChangesCheck | null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const scopeNow: Scope = scope === 'task' && !task ? (session ? 'session' : 'all') : scope === 'session' && !session ? 'all' : scope;

  const report = async (): Promise<string | null> => {
    try {
      const body =
        scopeNow === 'task' && session && task
          ? { sessionIds: [session.id], taskIds: [task.id], note }
          : scopeNow === 'session' && session
            ? { sessionIds: [session.id], note }
            : { sessionIds: sessions.map((s) => s.id), note };
      return (await api.kerriganReport(body)).text;
    } catch (e) {
      setSaid((e as Error).message);
      return null;
    }
  };
  const copy = async () => {
    const text = await report();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setSaid(t('wb.kCopied', { n: text.length }));
    } catch {
      setSaid(t('wb.kCopyFailed'));
    }
  };
  const save = async () => {
    const text = await report();
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `what-happened-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setSaid(t('wb.kSaved'));
  };
  const checkAnswer = async () => {
    setBusy(true);
    setResult('');
    try {
      setCheck(await api.checkChanges(answer));
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.applyChanges(answer);
      if (r.ok) {
        setResult(t('wb.kApplied', { n: r.applied.length }));
        setCheck(null);
        setAnswer('');
      } else setResult(r.problem ?? (r.check && !r.check.ok ? r.check.issues.map((i) => i.message).join(' ') : ''));
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };
  const looksLikePlan = !!check && !check.ok && /"sessions"\s*:/.test(answer) && !/"changes"\s*:/.test(answer);

  return (
    <div className="wb-kerrigan">
      <section>
        <h3>{t('wb.kTell')}</h3>
        <p className="muted small">{t('wb.kTellWhy')}</p>
        <fieldset className="wb-scope">
          <legend className="sr-only">{t('wb.kScope')}</legend>
          {task && (
            <label>
              <input type="radio" name="wb-k-scope" checked={scopeNow === 'task'} onChange={() => setScope('task')} /> {t('wb.kScopeTask')}
            </label>
          )}
          {session && (
            <label>
              <input type="radio" name="wb-k-scope" checked={scopeNow === 'session'} onChange={() => setScope('session')} /> {t('wb.kScopeSession')}
            </label>
          )}
          <label>
            <input type="radio" name="wb-k-scope" checked={scopeNow === 'all'} onChange={() => setScope('all')} /> {t('wb.kScopeAll')}
          </label>
        </fieldset>
        <label htmlFor="wb-k-note">{t('wb.kNote')}</label>
        <textarea id="wb-k-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('wb.kNotePlaceholder')} style={{ minHeight: 90 }} />
        <div className="row">
          <button type="button" className="primary" onClick={() => void copy()}>{t('wb.kCopy')}</button>
          <button type="button" onClick={() => void save()}>{t('wb.kSave')}</button>
          <Link className="button-link plain small" href="/import">{t('wb.kBrief')}</Link>
        </div>
        {said && <p className="small" role="status">{said}</p>}
      </section>
      <section>
        <h3>{t('wb.kAnswer')}</h3>
        <label htmlFor="wb-k-answer">{t('wb.kPaste')}</label>
        <textarea id="wb-k-answer" value={answer} onChange={(e) => { setAnswer(e.target.value); setCheck(null); }} style={{ minHeight: 110 }} />
        <div className="row">
          <button type="button" disabled={busy || !answer.trim()} onClick={() => void checkAnswer()}>{t('wb.kCheck')}</button>
          {check?.ok && (
            <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>{t('wb.kApply', { n: check.changes.length })}</button>
          )}
        </div>
        {check?.ok && (
          <>
            {check.notes && <p className="small">{check.notes}</p>}
            <ol className="wb-list small">
              {check.changes.map((c) => (
                <li key={c.index}>{c.says}</li>
              ))}
            </ol>
            {check.warnings.map((w) => (
              <p key={w} className="muted small">{w}</p>
            ))}
          </>
        )}
        {check && !check.ok && (
          <>
            {looksLikePlan ? (
              <p className="small">
                {t('wb.kIsPlan')} <Link href="/import">{t('wb.kImportPage')}</Link>
              </p>
            ) : (
              <ul className="wb-list small">
                {check.issues.map((i) => (
                  <li key={`${i.path}${i.message}`} className="bad">
                    {i.path && <code>{i.path}</code>} {i.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {result && <p className="notice small" role="status">{result}</p>}
      </section>
    </div>
  );
}
