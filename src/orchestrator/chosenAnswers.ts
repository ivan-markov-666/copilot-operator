/**
 * A question whose answers may be chosen more than one at a time (operator, 2026-11-02: "can the chat offer options not
 * only as radio buttons but as check boxes — more than one choice; I do not want them to look like radio buttons or
 * check boxes"): the answers chosen, by their place, checked against the question, and the answer they make — the
 * chosen ones as a list, with what the operator wrote under it. The card in the chat and the card of a queue task set
 * aside at the question answer through it alike.
 */

/** The answer of a question of several answers: as it is kept and shown, the chosen ones, and what was written. */
export type ChosenAnswer = { answer: string; chosen: string[]; written?: string };

export function chosenAnswer(question: { options: string[]; multiple?: boolean }, picks: unknown, written: string): ChosenAnswer | { problem: string } {
  if (!question.multiple) return { problem: 'This question takes one answer: press it, or write one.' };
  const valid = Array.isArray(picks) && picks.length > 0 && picks.every((n) => Number.isInteger(n) && n >= 0 && n < question.options.length);
  if (!valid) return { problem: 'Choose at least one of the answers offered.' };
  const chosen = [...new Set(picks as number[])].sort((a, b) => a - b).map((n) => question.options[n]!);
  const text = written.trim();
  return { answer: [chosen.map((c) => `- ${c}`).join('\n'), text].filter(Boolean).join('\n\n'), chosen, ...(text ? { written: text } : {}) };
}

/** What the chat or the lead is told after "The operator answered your question, ": the ones chosen, and what was written besides. */
export function chosenSaid(a: { chosen: string[]; written?: string }): string {
  const n = a.chosen.length;
  return [`choosing ${n === 1 ? 'one' : n} of your answers:`, '', ...a.chosen.map((c) => `- ${c}`), ...(a.written ? ['', 'And wrote:', '', a.written] : [])].join('\n');
}
