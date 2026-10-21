'use client';

/**
 * Where a two-chat message is against its lead's plan (operator's feedback, 2026-10-21: "1 of 20 subtasks" read as if
 * twenty were planned, when twenty is only the most allowed). From the lead's own list of subtasks (`LeadRecord.ledger`):
 * the phase, the subtask against the ones planned, how many are left — and the limit apart, never as the denominator;
 * a note where the plan changed, saying what came and went; and the list itself, by phase, under a fold. A message of
 * before the list, or whose lead sent none, says how many subtasks were used of the most allowed.
 */
import type { LeadLedger, LeadRecord, LeadRound, LeadTodo } from '../../lib/api';
import { useT } from '../../lib/i18n';

const MARK: Record<LeadTodo['status'] | 'stopped', string> = { done: '✓', running: '●', planned: '○', blocked: '⊘', failed: '✗', stopped: '■' };
const SAID = { done: 'lead.todo.done', running: 'lead.todo.running', planned: 'lead.todo.planned', blocked: 'lead.todo.blocked', failed: 'lead.todo.failed', stopped: 'lead.todo.stopped' } as const;

/** The phases of the list, in the order they first come; and the one the work is in. */
function phasesOf(ledger: LeadLedger): { phases: string[]; current: number } {
  const phases: string[] = [];
  for (const i of ledger.items) if (i.phase && !phases.includes(i.phase)) phases.push(i.phase);
  const at = ledger.items.find((i) => i.status === 'running') ?? ledger.items.find((i) => i.status === 'planned') ?? ledger.items.at(-1);
  return { phases, current: at?.phase ? phases.indexOf(at.phase) : -1 };
}

/** The counts under a message: the phase, the subtask against the plan, what is left, and the limit apart. */
export function LeadProgress({ lead, live }: { lead: LeadRecord; live: boolean }) {
  const { t } = useT();
  const ledger = lead.ledger;
  if (!ledger || ledger.items.length === 0) {
    return <p className="muted small cs-lead-progress">{t('lead.subtasks', { n: lead.subtasks, max: lead.maxSubtasks })}</p>;
  }
  const items = ledger.items;
  const count = (s: LeadTodo['status']): number => items.filter((i) => i.status === s).length;
  const running = items.findIndex((i) => i.status === 'running');
  const stuck = count('blocked') + count('failed');
  const { phases, current } = phasesOf(ledger);
  return (
    <div className="cs-lead-progress" role="status">
      {phases.length > 0 && current >= 0 && <p className="cs-lead-phase">{t('lead.phase', { n: current + 1, total: phases.length, title: phases[current]! })}</p>}
      <p className="small">
        <strong>{live && running >= 0 ? t('lead.subtaskOf', { n: running + 1, total: items.length }) : t('lead.doneOf', { done: count('done'), total: items.length })}</strong>
        {stuck > 0 && <span className="cs-lead-stuck"> · {t('lead.stuck', { n: stuck })}</span>}
      </p>
      <p className="muted small">{t('lead.left', { left: count('planned'), max: lead.maxSubtasks })}</p>
      <LedgerList ledger={ledger} live={live} />
    </div>
  );
}

/** The list itself, under a fold: by phase, each subtask with what it is at. */
function LedgerList({ ledger, live }: { ledger: LeadLedger; live: boolean }) {
  const { t } = useT();
  const { phases } = phasesOf(ledger);
  const groups: Array<{ phase: string; items: LeadTodo[] }> = phases.length === 0 ? [{ phase: '', items: ledger.items }] : [];
  if (phases.length > 0) {
    for (const p of phases) groups.push({ phase: p, items: ledger.items.filter((i) => i.phase === p) });
    const rest = ledger.items.filter((i) => !i.phase);
    if (rest.length > 0) groups.push({ phase: t('lead.otherPhase'), items: rest });
  }
  return (
    <details className="cs-ledger">
      <summary>{t('lead.ledgerList', { v: ledger.revision })}</summary>
      {groups.map((g) => (
        <div key={g.phase || '-'} className="cs-ledger-group">
          {g.phase && <p className="cs-ledger-phase">{g.phase}</p>}
          <ul>
            {g.items.map((i) => {
              // The one running when the work has ended was stopped there.
              const status = i.status === 'running' && !live ? 'stopped' : i.status;
              return (
                <li key={i.title} className={`cs-todo cs-todo-${status}`}>
                  <span className="cs-todo-mark" title={t(SAID[status])} aria-label={t(SAID[status])}>
                    {MARK[status]}
                  </span>
                  <span className="cs-todo-title">{i.title}</span>
                  {i.n ? (
                    <span className="muted small" title={t('lead.givenAs', { n: i.n })}>
                      {' '}
                      #{i.n}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** Where a reply of the lead's made its list or changed it: "the plan was updated (version 3): +2 new". */
export function LedgerChange({ change }: { change: NonNullable<LeadRound['ledger']> }) {
  const { t } = useT();
  if (change.revision === 1) return <p className="cs-system cs-ledger-change">{t('lead.ledgerFirst', { n: change.total })}</p>;
  const what = [change.added > 0 ? t('lead.ledgerAdded', { n: change.added }) : '', change.removed > 0 ? t('lead.ledgerRemoved', { n: change.removed }) : ''].filter(Boolean).join(', ') || t('lead.ledgerReordered');
  return <p className="cs-system cs-ledger-change">{t('lead.ledgerChanged', { v: change.revision, what })}</p>;
}
