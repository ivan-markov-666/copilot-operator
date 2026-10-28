'use client';

/**
 * "New branch from main", beside the chat's skills (operator, 2026-10-26: "a button near the skill option: it takes the
 * latest of main and makes a new local branch for the new task, a copy of the remote main; if a password is asked, a
 * window the bot never reads; and when the branch cannot simply be changed, the program offers a choice").
 *
 * Pressed, it fetches the remote's main — if the remote wants a password, Git opens its own window for it, which the
 * bot never reads — and shows what the new branch will start from, its name to change, and, when something is not
 * committed, whether to take it along, to put it aside on a branch of its own, or (2026-10-28) to commit it on the branch
 * the folder is on, with a message of the operator's or the default. A remote that could not be fetched is said, with
 * "Try again" and "Go on from what was last fetched". See `src/vcs/newBranch.ts`.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type NewBranchCarry, type NewBranchPlan, type Workspace } from '../../lib/api';
import { useFmtTime, useT } from '../../lib/i18n';
import { useDots } from '../../lib/useDots';
import { useModalFocus } from '../../lib/useModalFocus';

/** What the commit says when no message is written: the server's `COMMIT_BEFORE_NEW_BRANCH`. */
const COMMIT_BEFORE_NEW_BRANCH = 'Work in progress, before a new branch from main';

export function NewBranchButton({ workspace, running, onMade }: { workspace: Workspace | null; running: boolean; onMade: (result: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // Off while a task works (its branch is not changed under it) and where there is no repository; why, on hover.
  const off = running ? t('nb.offRunning') : !workspace?.ok ? t('nb.offNoFolder') : !workspace.isRepo ? t('nb.offNoRepo') : '';
  return (
    <>
      <button type="button" className="button-link plain small cs-new-branch" aria-disabled={off ? true : undefined} onClick={() => !off && setOpen(true)} title={off || t('nb.buttonWhy')}>
        {t('nb.button')}
      </button>
      {open && <NewBranchDialog onClose={() => setOpen(false)} onMade={(r) => { setOpen(false); onMade(r); }} />}
    </>
  );
}

function NewBranchDialog({ onClose, onMade }: { onClose: () => void; onMade: (result: string) => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const box = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  const [plan, setPlan] = useState<NewBranchPlan | null>(null);
  const [reading, setReading] = useState(true);
  const [name, setName] = useState('');
  const [carry, setCarry] = useState<NewBranchCarry>('take');
  /** The commit's message, when what is not committed is committed on the branch the folder is on; empty, the default. */
  const [message, setMessage] = useState('');
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState('');
  const [conflict, setConflict] = useState(false);
  const dots = useDots(reading || making);
  useModalFocus(box, true, first);

  const read = async (fetch: boolean) => {
    setReading(true);
    setProblem('');
    try {
      const p = await api.newBranchPreview(fetch);
      setPlan(p);
      if (p.suggested) setName((n) => n || p.suggested!);
    } catch (e) {
      setPlan(null);
      setProblem((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  useEffect(() => {
    void read(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !making) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [making, onClose]);

  const make = async () => {
    if (!plan?.fingerprint) return;
    setMaking(true);
    setProblem('');
    setConflict(false);
    try {
      const r = await api.newBranchCreate(name.trim(), carry, plan.fingerprint, carry === 'commit' ? message : undefined);
      if (r.ok) {
        onMade(r.result);
        return;
      }
      setProblem(r.problem);
      // Not taken across: putting them aside is the way that works, and is chosen for the next press.
      if (r.conflict) {
        setConflict(true);
        setCarry('aside');
      }
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setMaking(false);
    }
  };

  const dirty = (plan?.changed.length ?? 0) + (plan?.untracked.length ?? 0);
  const failedFetch = plan?.fetched && !plan.fetched.ok;
  const files = [...(plan?.changed ?? []), ...(plan?.untracked ?? [])];
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !making && onClose()}>
      <div ref={box} className="modal wide nb" role="dialog" aria-modal="true" aria-labelledby="nb-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="nb-title">{t('nb.title')}</h2>
        {reading ? (
          <div className="nb-reading" role="status">
            <p>
              {t('nb.fetching')}
              <span className="saving-dots">{dots}</span>
            </p>
            <p className="muted small">{t('nb.passwordNote')}</p>
          </div>
        ) : (
          <>
            {plan?.ok && (
              <>
                {failedFetch && (
                  <div className="nb-warn" role="alert">
                    <p>{t(plan.fetched!.auth ? 'nb.fetchAuth' : 'nb.fetchFailed', { remote: plan.remote ?? 'origin', detail: plan.fetched!.detail ?? '' })}</p>
                    <p className="small">{plan.lastFetched ? t('nb.lastFetched', { target: plan.target ?? '', at: fmtTime(plan.lastFetched) }) : t('nb.lastKnown', { target: plan.target ?? '' })}</p>
                    <div className="row">
                      <button type="button" onClick={() => void read(true)} disabled={making}>
                        {t('nb.tryAgain')}
                      </button>
                    </div>
                  </div>
                )}
                <p className="nb-from">
                  {t('nb.from', { target: plan.target ?? '', commit: (plan.targetCommit ?? '').slice(0, 8) })} {plan.targetSubject && <span className="muted">— {plan.targetSubject}</span>}
                </p>
                <p className="small muted">{plan.branch ? t('nb.now', { branch: plan.branch }) : t('nb.nowDetached')}</p>
                <div className="settings-field">
                  <label htmlFor="nb-name" className="field-label">
                    {t('nb.name')}
                  </label>
                  {/* Its name and what comes along are not changed while the branch is made (2026-10-26): off until it is, or did not work. */}
                  <input id="nb-name" type="text" dir="ltr" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} disabled={making} />
                </div>
                {dirty > 0 && (
                  <fieldset className="nb-dirty">
                    <legend>{t('nb.dirty', { n: dirty })}</legend>
                    <ul className="small nb-files">
                      {files.slice(0, 8).map((f) => (
                        <li key={f}>
                          <code>{f}</code>
                        </li>
                      ))}
                      {files.length > 8 && <li className="muted">{t('nb.more', { n: files.length - 8 })}</li>}
                    </ul>
                    <label className="nb-choice">
                      <input type="radio" name="nb-carry" checked={carry === 'take'} onChange={() => setCarry('take')} disabled={conflict || making} />
                      <span>
                        <strong>{t('nb.take')}</strong> <span className="muted small">{t('nb.takeWhy')}</span>
                      </span>
                    </label>
                    <label className="nb-choice">
                      <input type="radio" name="nb-carry" checked={carry === 'aside'} onChange={() => setCarry('aside')} disabled={making} />
                      <span>
                        <strong>{t('nb.aside')}</strong> <span className="muted small">{t('nb.asideWhy')}</span>
                      </span>
                    </label>
                    {/* Committed where they are (operator, 2026-10-28): on the branch the folder is on now; none on a detached HEAD. */}
                    <label className="nb-choice" title={plan.branch ? undefined : t('nb.commitDetached')}>
                      <input type="radio" name="nb-carry" checked={carry === 'commit'} onChange={() => setCarry('commit')} disabled={making || !plan.branch} />
                      <span>
                        <strong>{t('nb.commit', { branch: plan.branch ?? '—' })}</strong> <span className="muted small">{t('nb.commitWhy')}</span>
                      </span>
                    </label>
                    {carry === 'commit' && plan.branch && (
                      <div className="settings-field nb-message">
                        <label htmlFor="nb-message" className="field-label">
                          {t('nb.commitMessage')}
                        </label>
                        <input id="nb-message" type="text" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={COMMIT_BEFORE_NEW_BRANCH} disabled={making} maxLength={2000} />
                      </div>
                    )}
                  </fieldset>
                )}
                <p className="muted small">{t('nb.after')}</p>
              </>
            )}
            {problem && (
              <p className="err" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
        <div className="row modal-actions">
          <button ref={first} type="button" className="quiet" onClick={onClose} disabled={making}>
            {t('nb.cancel')}
          </button>
          {!reading && !plan?.ok && (
            <button type="button" onClick={() => void read(true)}>
              {t('nb.tryAgain')}
            </button>
          )}
          {!reading && plan?.ok && (
            <button type="button" className="primary" onClick={() => void make()} disabled={making || !name.trim()} aria-busy={making || undefined}>
              {making ? (
                <>
                  {t('nb.making')}
                  <span className="saving-dots">{dots}</span>
                </>
              ) : failedFetch ? (
                t('nb.makeFromLast')
              ) : (
                t('nb.make')
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
