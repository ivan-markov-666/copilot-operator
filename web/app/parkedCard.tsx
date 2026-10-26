'use client';

/**
 * A task the queue set aside while it waited for the operator (operator, 2026-10-26: "the UI keeps the question with
 * the plan, for the operator to approve it or ask for a correction later; everything is kept, even when the program is
 * closed"): what it waited for, shown again, with its answers — a plan to approve or send back, a question with the
 * answers it offered and a box for another, a subtask cut off with its choices, a command to run or skip, or just "I am
 * here" for a model to choose by hand or a password Git asked for. Answered, the task carries on from where it stopped
 * at the queue's next turn. On the queue's page and under the task's message in its chat alike.
 */
import { useId, useState } from 'react';
import type { Key } from '../lib/lang/types';
import type { Parked, ParkedAnswerInput, RetryChoice } from '../lib/api';
import { useFmtTime, useT } from '../lib/i18n';
import { useChoice } from '../lib/useChoice';
import { CopyButton } from './copyButton';
import { PlanView } from './planView';
import { RichText } from './richText';

const CHOICE: Record<RetryChoice, Key> = { same: 'retry.same', fresh: 'retry.fresh', continue: 'retry.continue', restore: 'retry.restore', accept: 'retry.accept' };
const WHAT: Record<Parked['kind'], Key> = {
  plan: 'pk.waitsPlan',
  question: 'pk.waitsQuestion',
  retry: 'pk.waitsRetry',
  command: 'pk.waitsCommand',
  model: 'pk.waitsModel',
  password: 'pk.waitsPassword',
};

export function ParkedCard({ parked, onAnswer }: { parked: Parked; onAnswer: (answer: ParkedAnswerInput) => Promise<void> }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const id = useId();
  const [text, setText] = useState('');
  // From the press, its other answers off and the one pressed marked; given back only when it did not arrive.
  const { locked, err, choose, mark } = useChoice();
  // Answered here: said at once, before the record is read again.
  const [sent, setSent] = useState<'' | 'answered' | 'stopped'>('');
  const a = parked.approval;
  const send = async (which: string, answer: ParkedAnswerInput) => {
    if (await choose(which, () => onAnswer(answer))) setSent('stop' in answer ? 'stopped' : 'answered');
  };
  if (parked.answer || sent) {
    return (
      <p className="small pk-answered" role="status">
        {t(sent === 'stopped' ? 'pk.stopped' : 'pk.answered')}
      </p>
    );
  }
  return (
    <div className="pk" role="group" aria-label={t('pk.title')}>
      <p className="small pk-head">
        <strong>{t('pk.title')}</strong> <span className="muted">{t('pk.since', { at: fmtTime(parked.at), what: t(WHAT[parked.kind]) })}</span>
      </p>
      {parked.kind === 'plan' && a.plan && (
        <>
          <PlanView plan={a.plan.plan} showApproval={false} />
          <label htmlFor={`${id}-note`} className="small">
            {t('pk.note')}
          </label>
          <textarea id={`${id}-note`} className="prose" rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={locked} />
          <div className="row">
            <button type="button" className="primary" {...mark('approve')} onClick={() => void send('approve', { decision: 'approve', ...(text.trim() ? { note: text.trim() } : {}) })}>
              {t('pk.approve')}
            </button>
            <button type="button" {...mark('revise')} disabled={locked || !text.trim()} onClick={() => void send('revise', { decision: 'revise', note: text.trim() })} title={text.trim() ? undefined : t('pk.reviseWhy')}>
              {t('pk.revise')}
            </button>
          </div>
        </>
      )}
      {parked.kind === 'question' && a.question && (
        <>
          <RichText text={a.question.text} />
          {a.question.why && <p className="muted small">{a.question.why}</p>}
          <div className="cs-copy-row">
            <CopyButton text={[a.question.text, a.question.why ?? '', ...a.question.options.map((o, i) => `${i + 1}. ${o}`)].filter(Boolean).join('\n')} what="chat.copyQuestion" />
          </div>
          {a.question.options.length > 0 && (
            <div className="row cs-options">
              {a.question.options.map((o, i) => (
                <button key={o} type="button" className={i === 0 ? 'primary cs-option' : 'cs-option'} {...mark(`option-${i}`)} onClick={() => void send(`option-${i}`, { answer: o })}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <label htmlFor={`${id}-answer`} className="small">
            {t('lead.answer')}
          </label>
          <textarea id={`${id}-answer`} className="prose" rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={locked} />
          <div className="row">
            <button type="button" className="primary" {...mark('written')} disabled={locked || !text.trim()} onClick={() => void send('written', { answer: text.trim() })}>
              {t('lead.send')}
            </button>
          </div>
        </>
      )}
      {parked.kind === 'retry' && a.retry && (
        <>
          <p className="small">
            {t('retry.title', { n: a.retry.n })} — {a.retry.title}
          </p>
          {a.retry.reason && <p className="small">{t('retry.reason', { reason: a.retry.reason })}</p>}
          {a.retry.sideEffects === 'unknown' && <p className="reason small">{t('retry.unknown')}</p>}
          <div className="row">
            {a.retry.choices.map((c, i) => (
              <button key={c} type="button" className={i === 0 ? 'primary' : undefined} {...mark(c)} onClick={() => void send(c, { choice: c })}>
                {t(CHOICE[c])}
              </button>
            ))}
          </div>
        </>
      )}
      {parked.kind === 'command' && (
        <>
          <pre className="cs-out">{a.description}</pre>
          {a.platform && <p className="reason small">{t('approval.platform', { platform: a.platform })}</p>}
          {a.readOnly && <p className="reason small">{t('approval.readOnly')}</p>}
          <div className="row">
            <button type="button" className="primary" {...mark('run')} onClick={() => void send('run', { decision: 'run' })}>
              {t('pk.run')}
            </button>
            <button type="button" {...mark('skip')} onClick={() => void send('skip', { decision: 'skip' })}>
              {t('pk.skip')}
            </button>
          </div>
        </>
      )}
      {(parked.kind === 'model' || parked.kind === 'password') && (
        <>
          <p className="small">{t(parked.kind === 'model' ? 'pk.modelWhy' : 'pk.passwordWhy')}</p>
          <div className="row">
            <button type="button" className="primary" {...mark('resume')} onClick={() => void send('resume', { resume: true })}>
              {t('pk.resume')}
            </button>
          </div>
        </>
      )}
      <div className="row pk-stop">
        <button type="button" className="quiet" {...mark('stop')} onClick={() => void send('stop', { stop: true })}>
          {t('pk.stop')}
        </button>
      </div>
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
