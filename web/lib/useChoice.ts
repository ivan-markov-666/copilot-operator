'use client';

import { useRef, useState } from 'react';

/** The answer chosen on a card: on its way, or given. */
export type ChoiceState = 'sending' | 'sent';

/**
 * One answer to a card that offers several — run, skip or stop a command; approve a plan or send it back; one of a
 * question's answers or one written out; a subtask's choices (operator, 2026-10-26: "when one of the possibilities is
 * chosen, make the other inputs for the same thing inactive"). From the press, every input of the card is off and the
 * answer chosen is marked, on its way and then given, until the card goes, however long the screen takes to be read
 * again: a card answered never offers its answers a second time. Only an answer that did not arrive gives them back,
 * its error said on the card.
 *
 * `send` throws, or returns false, when the answer did not arrive; false when the caller has said why itself.
 */
export function useChoice() {
  const [chosen, setChosen] = useState<{ which: string; state: ChoiceState } | null>(null);
  const [err, setErr] = useState('');
  // A ref, not only the state: a double click's second press lands before the re-render that turns the inputs off.
  const taken = useRef(false);
  const choose = async (which: string, send: () => Promise<boolean | void>): Promise<boolean> => {
    if (taken.current) return false;
    taken.current = true;
    setChosen({ which, state: 'sending' });
    setErr('');
    let ok = false;
    try {
      ok = (await send()) !== false;
    } catch (e) {
      setErr((e as Error).message);
    }
    if (ok) setChosen({ which, state: 'sent' });
    else {
      taken.current = false;
      setChosen(null);
    }
    return ok;
  };
  /** One answer's button: off once any is chosen, and marked when it is the one. */
  const mark = (which: string) => ({ disabled: chosen !== null, 'data-chosen': chosen?.which === which ? chosen.state : undefined });
  return { locked: chosen !== null, err, setErr, choose, mark };
}
