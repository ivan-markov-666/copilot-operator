'use client';

/**
 * Starting one queued task from where it is shown, and getting a task that contradicts itself back
 * into a state where it can be started.
 *
 * Both are here, shared by the register and the session page, for the reason `taskActions` is: a
 * queued task was seen on either page with no way to set it off. The only start buttons were the
 * session's and the register's "Continue", which take a whole queue, so a task fixed and put back
 * in the queue looked startable — a marker beside it, actions beside the attempt that failed — and
 * was not, on its own (operator feedback 2026-10-08).
 *
 * The panel says what will run and what will not before anything does: only this task, or this one
 * and the queued tasks after it in its session; the tasks that already ran, done or not, are never
 * touched, and an earlier task of a chain that did not succeed is named, not refused.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { api, type ContractConflict, type ContractFix, type Session, type Task, type TaskStatus } from '../lib/api';
import { useT, type Key } from '../lib/i18n';
import { usePoll } from '../lib/usePoll';
import { runQueuedSelection } from '../lib/runSelection';
import { confirmDialog } from './dialog';
import { useUnattendedWithoutAsking } from '../lib/useUnattendedWithoutAsking';

export type RunQueuedTarget = { sessionId: string; taskId: string; title: string };
type T = (key: Key, vars?: Record<string, string | number>) => string;

/**
 * "Run this task": the choice between this one alone and this one with the queued ones after it,
 * what each takes, and the two ways to start. `onClose(true)` once a run has started.
 */
export function RunQueuedPanel({
  target,
  intro,
  initial = 'one',
  focusFirst = false,
  checkContract = true,
  onClose,
}: {
  target: RunQueuedTarget;
  /** Said first, when the panel is offered rather than asked for — "queued again; run it now?". */
  intro?: string;
  initial?: 'one' | 'following';
  /** Put the keyboard on the first start button once the panel has read its session (an offer in a dialog). */
  focusFirst?: boolean;
  /** Look for contradictions as it opens; off where the page around it already shows the task's fix panel. */
  checkContract?: boolean;
  onClose: (started: boolean) => void;
}) {
  const { t } = useT();
  const quietStart = useUnattendedWithoutAsking();
  const [session, setSession] = useState<Session | null>(null);
  const [which, setWhich] = useState<'one' | 'following'>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** Set when the start was refused because the task contradicts itself: the fixes are offered in place. */
  const [contradicts, setContradicts] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);

  const laterRef = useRef<HTMLButtonElement | null>(null);
  // Radio names of this panel only: two panels of one task on a page must not share a group.
  const uid = useId();

  const load = () =>
    api
      .session(target.sessionId)
      .then(setSession)
      .catch((e: unknown) => setMsg((e as Error).message));
  useEffect(() => {
    void load();
    /*
     * A task that contradicts itself would be refused at the start: its fixes are shown as the panel opens,
     * not only after a press that is bound to be refused. The refusals at the session's Start and at
     * Continue send the operator here for them.
     */
    if (checkContract) {
      void api
        .contractCheck(target.sessionId, target.taskId)
        .then((c) => setContradicts(c.conflicts.length > 0))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.sessionId, target.taskId]);
  // Read again while the session is busy, so the buttons come back when its run ends rather than staying shut on an old reading.
  usePoll(load, 3000, !!session?.running);

  // Brought into view, and the keyboard to it when it was offered: it opens where the operator may not be looking.
  const loaded = session !== null;
  useEffect(() => {
    if (!loaded) return;
    boxRef.current?.scrollIntoView?.({ block: 'nearest' });
    if (!focusFirst) return;
    // The first start button, or "Later" when the buttons are shut or the task is not waiting any more.
    const first = firstRef.current;
    if (first && !first.disabled) first.focus();
    else laterRef.current?.focus();
  }, [loaded, focusFirst]);

  if (!session) {
    return (
      <div className="notice calm" style={{ marginTop: 8 }}>
        <span className="small">{msg || t('runq.loading')}</span>
      </div>
    );
  }
  const sel = runQueuedSelection(session, target.taskId);
  const queued = sel.task?.status === 'queued';
  const runs = which === 'following' ? [sel.task!, ...sel.followingQueued] : sel.task ? [sel.task] : [];
  // What keeps the buttons shut, said beside them: the session's own run, or the session set aside.
  const shut = session.running ? t('runq.sessionRunning') : session.active === false ? t('runq.sessionInactive') : '';

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !quietStart && !(await confirmDialog(t('batch.unattendedConfirm', { n: 1 })))) return;
    setBusy(true);
    setMsg('');
    setContradicts(false);
    try {
      const name = await api.suggestedRunName([target.sessionId]).then((r) => r.name).catch(() => undefined);
      const r = await api.startBatch([target.sessionId], mode, 'stop', undefined, undefined, name, runs.map((x) => x.id));
      if (!r.started) {
        setMsg(t('batch.notStarted', { reason: r.reason ?? '' }));
        // A refusal for a contradiction is answered with its fixes, here, rather than with a sentence to act on elsewhere.
        const check = await api.contractCheck(target.sessionId, target.taskId).catch(() => ({ conflicts: [] as ContractConflict[] }));
        setContradicts(check.conflicts.length > 0);
        return;
      }
      setMsg(t('runq.started', { n: runs.length }));
      onClose(true);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = t('runq.title', { title: target.title });
  return (
    <div ref={boxRef} className="notice calm" role="group" aria-label={label} style={{ marginTop: 8 }}>
      {intro && <p className="small" style={{ marginTop: 0 }}>{intro}</p>}
      <strong>{label}</strong>
      {!queued ? (
        <p className="small">{t('runq.notQueued', { status: t(`status.${sel.task?.status ?? 'queued'}` as Key) })}</p>
      ) : (
        <>
          {/* A choice only where there is one: with nothing queued after it, this task is all there is to run. */}
          {sel.followingQueued.length > 0 && (
            <div className="small" role="radiogroup" aria-label={label} style={{ marginTop: 6 }}>
              <label className="option-inline">
                <input type="radio" name={`runq-${uid}`} checked={which === 'one'} onChange={() => setWhich('one')} disabled={busy} />
                {t('runq.onlyThis')}
              </label>
              <label className="option-inline" title={t('runq.followingWhy')}>
                <input type="radio" name={`runq-${uid}`} checked={which === 'following'} onChange={() => setWhich('following')} disabled={busy} />
                {t('runq.following', { n: sel.followingQueued.length, session: session.name })}
              </label>
            </div>
          )}
          <div className="small" style={{ marginTop: 6 }}>{t('runq.willRun')}</div>
          <ol className="small" style={{ margin: '4px 0', paddingLeft: 22 }}>
            {runs.map((x) => (
              <li key={x.id}>{x.title}</li>
            ))}
          </ol>
          <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
            {sel.chain && runs.length > 1 && <li>{t('runq.chainStops')}</li>}
            {sel.earlierRan.length > 0 && <li>{t('runq.untouched', { n: sel.earlierRan.length })}</li>}
            {sel.laterRan.length > 0 && <li>{t('runq.laterRan', { list: sel.laterRan.map((x) => `"${x.title}"`).join(', ') })}</li>}
            {which === 'one' && sel.followingQueued.length > 0 && <li>{t('runq.restWait', { n: sel.followingQueued.length })}</li>}
          </ul>
          {sel.chainGap && (
            <div className="notice caution small" style={{ marginTop: 6 }}>
              {t('runq.chainGap', { before: sel.chainGap.title, status: t(`status.${sel.chainGap.status}` as Key) })}
            </div>
          )}
          {which === 'following' && sel.chainGapLater && (
            <div className="notice caution small" style={{ marginTop: 6 }}>
              {t('runq.chainGapLater', { between: sel.chainGapLater.title, status: t(`status.${sel.chainGapLater.status}` as Key) })}
            </div>
          )}
          {shut && <p className="small">{shut}</p>}
        </>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {queued && (
          <>
            <button ref={firstRef} className="primary" disabled={busy || !!shut} onClick={() => void start('confirm')} title={t('runq.goWhy')}>
              {t('runq.go')}
            </button>
            <button disabled={busy || !!shut} onClick={() => void start('unattended')} title={t('runq.unattendedWhy')}>
              {t('runq.unattended')}
            </button>
          </>
        )}
        <button ref={laterRef} className="quiet" disabled={busy} onClick={() => onClose(false)}>
          {intro ? t('runq.later') : t('dialog.cancel')}
        </button>
        {msg && (
          <span className="small" role="status">
            {msg}
          </span>
        )}
      </div>
      {contradicts && (
        <ContractFixPanel
          target={target}
          onApplied={(remaining, changed) => {
            void load();
            // While something is left the fix panel stays, with what was changed and what is still in the way;
            // once nothing is, it goes, and what changed is said here, beside the buttons that start it now.
            if (remaining === 0) {
              setContradicts(false);
              setMsg(changed);
            }
          }}
        />
      )}
    </div>
  );
}

/** What one fix does, in the operator's words. */
function fixWords(t: T, fix: ContractFix): string {
  if (fix.kind === 'add-to-scope') return t('cfix.addToScope', { path: fix.path });
  if (fix.kind === 'not-read-only') return fix.scope.length > 0 ? t('cfix.notReadOnly', { paths: fix.scope.join(', ') }) : t('cfix.notReadOnlyAll');
  if (fix.kind === 'drop-scope') return t('cfix.dropScope');
  return t('cfix.dropCheck', { check: fix.check });
}

type Contract = Pick<Task, 'readOnly' | 'scope' | 'checks'>;

/**
 * What changed in the contract, read from before and after, in the operator's language. Not the fixes
 * chosen one by one: two of them can pull different ways, and listed side by side read as a contradiction.
 */
function changeWords(t: T, before: Contract, after: Contract): string {
  const out: string[] = [];
  if (!!before.readOnly !== !!after.readOnly) out.push(after.readOnly ? t('cfix.chReadOnlyOn') : t('cfix.chReadOnlyOff'));
  const was = (before.scope ?? []).join(', ');
  const now = (after.scope ?? []).join(', ');
  if (was !== now) out.push(now ? t('cfix.chScope', { paths: now }) : t('cfix.chScopeRemoved'));
  const kept = new Set((after.checks ?? []).map((c) => c.name));
  for (const c of before.checks ?? []) if (!kept.has(c.name)) out.push(t('cfix.chDropped', { check: c.name }));
  return out.join('; ');
}

/**
 * The ways out of each contradiction, the least change chosen, and one press to apply them. Changes
 * the contract only — scope, read-only, the task's own checks — and queues the task; nothing starts.
 * The prompt is the operator's to change, in the edit form.
 */
export function ContractFixPanel({
  target,
  onApplied,
}: {
  target: RunQueuedTarget;
  /** `changed`: what was changed, said in full ("Changed: …"), for a caller that replaces this panel with the next step. */
  onApplied: (remaining: number, changed: string) => void;
}) {
  const { t } = useT();
  const [conflicts, setConflicts] = useState<ContractConflict[] | null>(null);
  const [choices, setChoices] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState<TaskStatus | null>(null);
  /** The contract as it was read, to say afterwards what changed. */
  const [before, setBefore] = useState<Contract | null>(null);
  const uid = useId();

  const load = () => {
    setConflicts(null);
    void Promise.all([api.contractCheck(target.sessionId, target.taskId), api.session(target.sessionId)])
      .then(([check, session]) => {
        const task = session.tasks.find((x) => x.id === target.taskId);
        setConflicts(check.conflicts);
        // The least change is chosen for every contradiction that has a way out.
        setChoices(check.conflicts.map((c) => (c.fixes.length > 0 ? 0 : -1)));
        setStatus(task?.status ?? null);
        setBefore(task ? { readOnly: task.readOnly, scope: task.scope, checks: task.checks } : null);
      })
      .catch((e: unknown) => setMsg((e as Error).message));
  };
  useEffect(load, [target.sessionId, target.taskId]);

  const apply = async () => {
    if (!conflicts) return;
    setBusy(true);
    setMsg('');
    try {
      // The contradictions the choices were made from go with them: the API refuses if the task's are others by now.
      const r = await api.applyContractFix(target.sessionId, target.taskId, choices, conflicts.map((c) => c.text));
      const changed = t('cfix.applied', { list: (before ? changeWords(t, before, r.task) : r.applied.join('; ')) || t('cfix.chNothing') });
      setMsg(changed + (r.remaining.length > 0 ? ` ${t('cfix.remaining', { n: r.remaining.length })}` : ''));
      setConflicts(r.remaining);
      setChoices(r.remaining.map((c) => (c.fixes.length > 0 ? 0 : -1)));
      setStatus('queued');
      setBefore({ readOnly: r.task.readOnly, scope: r.task.scope, checks: r.task.checks });
      onApplied(r.remaining.length, changed);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = t('cfix.title', { title: target.title });
  return (
    <div className="notice caution" role="group" aria-label={title} style={{ marginTop: 8 }}>
      <strong>{title}</strong>
      <p className="why">{t('cfix.why')}</p>
      {conflicts === null ? (
        <p className="small">{msg || t('cfix.loading')}</p>
      ) : conflicts.length === 0 ? (
        <p className="small" role="status">
          {msg || t('cfix.none')}
        </p>
      ) : (
        <>
          {conflicts.map((c, i) => (
            <fieldset key={i} className="small" style={{ margin: '8px 0', border: 0, padding: 0 }}>
              <legend style={{ fontWeight: 600 }}>{c.text}</legend>
              {c.fixes.map((f, j) => (
                <label key={j} className="option-inline" style={{ display: 'block' }}>
                  <input
                    type="radio"
                    name={`cfix-${uid}-${i}`}
                    checked={choices[i] === j}
                    onChange={() => setChoices((prev) => prev.map((v, k) => (k === i ? j : v)))}
                    disabled={busy}
                  />
                  {fixWords(t, f)}
                  {j === 0 && <span className="muted"> {t('cfix.minimal')}</span>}
                </label>
              ))}
              <label className="option-inline" style={{ display: 'block' }}>
                <input
                  type="radio"
                  name={`cfix-${uid}-${i}`}
                  checked={choices[i] === -1}
                  onChange={() => setChoices((prev) => prev.map((v, k) => (k === i ? -1 : v)))}
                  disabled={busy}
                />
                {c.fixes.length > 0 ? t('cfix.leave') : t('cfix.noFix')}
              </label>
            </fieldset>
          ))}
          <div className="row">
            <button className="primary" disabled={busy || choices.every((c) => c === -1)} onClick={() => void apply()}>
              {status === 'queued' ? t('cfix.applyQueued') : t('cfix.apply')}
            </button>
            {msg && (
              <span className="small" role="status">
                {msg}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
