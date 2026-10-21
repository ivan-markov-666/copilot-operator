/**
 * The lead's list of subtasks, as the runner keeps it (operator's feedback, 2026-10-21).
 *
 * "1 of 20 subtasks" read as if twenty were planned, when twenty is only the most the lead may give. The lead now sends
 * its whole list with every plan and every subtask (`todo` in `leadSchema.ts`): what it has done — "done" once it has
 * accepted the report —, the one it gives now, the ones still to come, each in a phase of the plan if it names one. This
 * keeps that list, numbered by version: the version goes up when subtasks are added, dropped or put in another order —
 * a status moving on is progress, not a new plan — and the last change's additions and drops are kept for the chat to
 * say "the plan was updated: 2 new".
 *
 * The runner is lenient where the lead's wording differs from its own: the subtask given now is the list's "running"
 * one, found by its title, or the one marked running, or put in where the planned ones begin; any other "running" is
 * set back to "planned", so exactly one is running while the worker works.
 */
import type { LeadLedger, LeadTodo } from '../session/model.js';
import type { TodoItem } from '../protocol/leadSchema.js';

/** A title as two of them are compared: case, punctuation, a leading number and spacing set aside. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*(?:subtask\s*)?\d+\s*[.):-]\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The same subtask, said the same or nearly: one title contains the other, once they are both long enough to tell. */
export function sameTitle(a: string, b: string): boolean {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

export type LedgerChange = { revision: number; added: number; removed: number; total: number };

/**
 * The list after a reply of the lead's. `todo` is the list the reply sent, if it sent one; `giving` the subtask it gives
 * now, with the number it will have. With no list in the reply, the one before stands (a question, the result). The
 * change is returned when the list is new or its version went up.
 */
export function nextLedger(
  before: LeadLedger | undefined,
  todo: TodoItem[] | undefined,
  at: string,
  giving?: { title: string; n: number },
): { ledger: LeadLedger | undefined; change?: LedgerChange } {
  if (!todo || todo.length === 0) return { ledger: before };
  // One entry a title, the first one as sent.
  const items: LeadTodo[] = [];
  for (const t of todo) {
    if (items.some((i) => titleKey(i.title) === titleKey(t.title))) continue;
    const known = before?.items.find((i) => titleKey(i.title) === titleKey(t.title));
    items.push({ title: t.title.trim(), status: t.status, ...(t.phase ? { phase: t.phase } : {}), ...(known?.n ? { n: known.n } : {}) });
  }
  if (giving) {
    const running = items.filter((i) => i.status === 'running');
    let mine = items.find((i) => i.status !== 'done' && sameTitle(i.title, giving.title)) ?? (running.length === 1 ? running[0] : undefined);
    if (!mine) {
      mine = { title: giving.title.trim(), status: 'running' };
      const firstPlanned = items.findIndex((i) => i.status === 'planned');
      items.splice(firstPlanned >= 0 ? firstPlanned : items.length, 0, mine);
    }
    for (const i of items) if (i.status === 'running' && i !== mine) i.status = 'planned';
    mine.status = 'running';
    mine.n = giving.n;
  }
  const keys = items.map((i) => titleKey(i.title));
  const was = before?.items.map((i) => titleKey(i.title)) ?? [];
  const added = items.filter((i) => !was.includes(titleKey(i.title))).map((i) => i.title);
  const removed = (before?.items ?? []).filter((i) => !keys.includes(titleKey(i.title))).map((i) => i.title);
  // The ones in both, in the order of each: another order is another plan.
  const common = keys.filter((k) => was.includes(k));
  const reordered = common.join('\n') !== was.filter((k) => keys.includes(k)).join('\n');
  const changed = !before || added.length > 0 || removed.length > 0 || reordered;
  const revision = before ? before.revision + (changed ? 1 : 0) : 1;
  const ledger: LeadLedger = {
    revision,
    items,
    at,
    ...(changed ? (added.length > 0 ? { added } : {}) : before?.added ? { added: before.added } : {}),
    ...(changed ? (removed.length > 0 ? { removed } : {}) : before?.removed ? { removed: before.removed } : {}),
  };
  return { ledger, ...(changed ? { change: { revision, added: added.length, removed: removed.length, total: items.length } } : {}) };
}

/** The list at the end of the work: the one running is done when the lead delivered, blocked when it could not. */
export function closeLedger(ledger: LeadLedger | undefined, how: 'done' | 'blocked'): LeadLedger | undefined {
  if (!ledger) return ledger;
  return { ...ledger, items: ledger.items.map((i) => (i.status === 'running' ? { ...i, status: how } : i)) };
}

/** The counts the chat and the lead are given: where the work is against the plan, and the limit apart. */
export function ledgerCounts(ledger: LeadLedger): { total: number; done: number; running: number; planned: number; stuck: number; current: number } {
  const of = (s: LeadTodo['status']): number => ledger.items.filter((i) => i.status === s).length;
  const at = ledger.items.findIndex((i) => i.status === 'running');
  return { total: ledger.items.length, done: of('done'), running: of('running'), planned: of('planned'), stuck: of('blocked') + of('failed'), current: at >= 0 ? at + 1 : 0 };
}

/** The list as the lead is shown it with a report: one line a subtask, its status, its phase. */
export function describeLedger(ledger: LeadLedger, given: number, max: number): string {
  const c = ledgerCounts(ledger);
  return [
    `Your list of subtasks (version ${ledger.revision}): ${c.done} done, ${c.running} running, ${c.planned} planned${c.stuck > 0 ? `, ${c.stuck} blocked or failed` : ''}. Subtasks given so far: ${given}; at most ${max} may be given.`,
    ...ledger.items.map((i, k) => `${k + 1}. [${i.status}] ${i.title}${i.phase ? ` — ${i.phase}` : ''}`),
    'Send the whole list again with your next subtask or plan: mark the one just reported "done" if you accept its report, "blocked" or "failed" if not; add what it showed is needed, drop what is not.',
  ].join('\n');
}
