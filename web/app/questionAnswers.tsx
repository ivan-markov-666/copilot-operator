'use client';

/**
 * A question of the chat or the lead, answered on its card in the conversation and on the card of a queue task set
 * aside at it alike: the answers it offers, a field for another, and what "Copy" takes.
 *
 * One answer (2026-10-23): a press sends it. Several (operator, 2026-11-02: "can the chat offer options not only as
 * radio buttons but as check boxes — more than one choice; I do not want them to look like radio buttons or check
 * boxes"): the same buttons, a press marks one as chosen or not, and one button sends the ones chosen, with whatever is
 * written in the field besides.
 *
 * "Copy" (operator, 2026-11-02: "the copy button copies the different answers too, and that one can be written in the
 * field"): the question, why, every answer offered — the recommended one and what one runs said — and how it is
 * answered on the card.
 */
import { useState, type ReactNode } from 'react';
import type { useChoice } from '../lib/useChoice';
import { useT } from '../lib/i18n';

type Question = { text: string; why?: string; options: string[]; commands?: Array<string | null>; multiple?: boolean };
type T = ReturnType<typeof useT>['t'];

/** What "Copy" takes from a question; `open` while it waits for its answer, with how it is answered on the card. */
export function questionCopy(t: T, q: Question, open: boolean): string {
  const send = t(q.multiple ? 'chat.sendChosen' : 'lead.send');
  const offered = q.options.map((o, i) => [`${i + 1}. ${o}${i === 0 ? ` (${t('chat.optionRecommended')})` : ''}`, ...(q.commands?.[i] ? [`   ${t('chat.optionRuns', { cmd: q.commands[i]! })}`] : [])].join('\n'));
  const head = !open ? t('chat.copyOffered') : q.multiple ? t('chat.copyMany', { send }) : t('chat.copyOne');
  return [
    q.text,
    q.why ?? '',
    offered.length > 0 ? [head, ...offered].join('\n') : '',
    open ? t(q.multiple ? 'chat.copyWriteMany' : 'chat.copyWrite', { answer: t('lead.answer'), send }) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The answers to press, the field for another and the button that sends it; `children` go beside that button. `onAnswer`
 * gets `which` (the button pressed, for the card's mark) and the answer: an offered one's text, what was written, or the
 * ones chosen by their place.
 */
export function QuestionAnswers({ id, q, locked, mark, rows = 3, onAnswer, children }: {
  id: string;
  q: Question;
  locked: boolean;
  mark: ReturnType<typeof useChoice>['mark'];
  rows?: number;
  onAnswer: (which: string, answer: { text: string; chosen?: number[] }) => void;
  children?: ReactNode;
}) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const many = !!q.multiple;
  const toggle = (i: number): void => setChosen((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i].sort((a, b) => a - b)));
  const sendMany = (): void => (chosen.length > 0 ? onAnswer('chosen', { text, chosen }) : onAnswer('written', { text }));
  return (
    <>
      {many && q.options.length > 0 && <p className="small cs-many-hint">{t('chat.manyHint', { send: t('chat.sendChosen'), answer: t('lead.answer') })}</p>}
      {/*
        Its answers to click (2026-10-23), the chat's recommended one first; an answer that carries a command says it
        runs it, and the bot runs it when it is chosen — nothing for the operator to type.
      */}
      {q.options.length > 0 && (
        <div className="row cs-options">
          {q.options.map((o, i) =>
            many ? (
              <button key={i} type="button" className="cs-option" aria-pressed={chosen.includes(i)} disabled={locked} onClick={() => toggle(i)} title={i === 0 ? t('chat.optionRecommended') : undefined}>
                <span>{o}</span>
              </button>
            ) : (
              <button key={i} type="button" className={i === 0 ? 'primary cs-option' : 'cs-option'} {...mark(`option-${i}`)} onClick={() => onAnswer(`option-${i}`, { text: o })} title={i === 0 ? t('chat.optionRecommended') : undefined}>
                <span>{o}</span>
                {q.commands?.[i] && <code className="cs-option-run">{t('chat.optionRuns', { cmd: q.commands[i]! })}</code>}
              </button>
            ),
          )}
        </div>
      )}
      <label htmlFor={`${id}-answer`} className="small">
        {t('lead.answer')}
      </label>
      <textarea id={`${id}-answer`} className="prose" rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder={t(many ? 'chat.manyPlaceholder' : 'lead.answerPlaceholder')} disabled={locked} />
      <div className="row">
        {many ? (
          <button type="button" className="primary" {...mark(chosen.length > 0 ? 'chosen' : 'written')} disabled={locked || (chosen.length === 0 && !text.trim())} onClick={sendMany}>
            {t('chat.sendChosen')}
          </button>
        ) : (
          <button type="button" className="primary" {...mark('written')} disabled={locked || !text.trim()} onClick={() => onAnswer('written', { text })}>
            {t('lead.send')}
          </button>
        )}
        {children}
      </div>
    </>
  );
}
