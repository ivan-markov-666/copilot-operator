/**
 * The clock stands still while the work is paused (operator, 2026-10-21: "when paused, the time must stop being
 * measured"): `Hold` keeps each pause from "Pause" to "Continue", the runner takes them off a task's minutes against
 * its limit, and the page takes them off the minutes it shows (web/lib/paused.ts) — the same arithmetic on both sides.
 * Held here: a pause going on counts to now; one before the task began counts only from its start; several add up;
 * the page's minutes do not move while paused.
 *
 *   npm run check:pause-clock
 */
import { Hold, pausedWithin, WaitsFor } from '../src/orchestrator/hold.js';
import { workedMs } from '../web/lib/paused.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const min = 60_000;
const T0 = Date.parse('2026-10-21T12:00:00.000Z');

t.check('a pause going on counts to now', pausedWithin([{ from: T0 + 2 * min }], T0, T0 + 5 * min), 3 * min);
t.check('one from before the task began counts from its start', pausedWithin([{ from: T0 - 4 * min, to: T0 + min }], T0, T0 + 5 * min), min);
t.check('several add up; one after now does not count', pausedWithin([{ from: T0 + min, to: T0 + 2 * min }, { from: T0 + 3 * min, to: T0 + 4 * min }, { from: T0 + 9 * min }], T0, T0 + 5 * min), 2 * min);

{
  const realNow = Date.now;
  let clock = T0;
  Date.now = () => clock;
  try {
    const hold = new Hold();
    clock = T0 + 10 * min;
    hold.pause();
    clock = T0 + 13 * min;
    t.check('Hold: paused three minutes so far, from the press', hold.pausedSince(T0), 3 * min);
    hold.resume();
    clock = T0 + 20 * min;
    t.check('and no more once continued', hold.pausedSince(T0), 3 * min);
    t.check('its pauses, for the page', hold.pauses, [{ from: new Date(T0 + 10 * min).toISOString(), to: new Date(T0 + 13 * min).toISOString() }]);
    t.check('pressed twice, one pause', [hold.pause(), hold.pause(), hold.pauses.length], [true, false, 2]);
  } finally {
    Date.now = realNow;
  }
}

/*
 * Waiting for the operator (operator, 2026-10-29: "while the bot waits for the user to type something or answer, it
 * must not count against the time the chat may be used"): a card, Git's password window, a sign-in, each from the
 * moment it waits to its answer, taken off as a pause is — the time two of them overlap, or a pause and one, once.
 */
{
  const realNow = Date.now;
  let clock = T0;
  Date.now = () => clock;
  try {
    const hold = new Hold();
    clock = T0 + 5 * min;
    hold.waitFor('card:a');
    clock = T0 + 8 * min;
    t.check('a card waiting: three minutes so far, not counted', hold.pausedSince(T0), 3 * min);
    hold.pause();
    clock = T0 + 10 * min;
    hold.waited('card:a');
    clock = T0 + 12 * min;
    hold.resume();
    t.check('paused while the card waited: from the card to Continue, counted once', hold.pausedSince(T0), 7 * min);
    clock = T0 + 15 * min;
    hold.waitFor('pw:s');
    hold.waitFor('card:b');
    clock = T0 + 16 * min;
    hold.waited('pw:s');
    clock = T0 + 18 * min;
    hold.waited('card:b');
    clock = T0 + 30 * min;
    t.check('two waits at once, counted once', hold.pausedSince(T0), 10 * min);
    t.check('for the page, the time not counted, overlaps joined', hold.pauses, [
      { from: new Date(T0 + 5 * min).toISOString(), to: new Date(T0 + 12 * min).toISOString() },
      { from: new Date(T0 + 15 * min).toISOString(), to: new Date(T0 + 18 * min).toISOString() },
    ]);
    hold.waited('card:a');
    hold.waited('never');
    hold.waitFor('card:c');
    clock = T0 + 31 * min;
    hold.waitFor('card:c');
    clock = T0 + 32 * min;
    t.check('an end with no wait, or a second start of one waiting, changes nothing', hold.pausedSince(T0), 12 * min);
    t.check('a wait going on is open for the page', hold.pauses.at(-1), { from: new Date(T0 + 30 * min).toISOString() });
    t.check('and is not the operator\'s pause', hold.held, false);
  } finally {
    Date.now = realNow;
  }
}

{
  // The cards, kept as before in one map, start and end their waits by themselves: set once, deleted once, cleared.
  const seen: string[] = [];
  const cards = new WaitsFor<{ n: number }>((key, _v, begins) => seen.push(`${begins ? '+' : '-'}${key}`));
  cards.set('a', { n: 1 });
  cards.set('a', { n: 2 });
  cards.set('b', { n: 3 });
  cards.delete('a');
  cards.delete('a');
  cards.set('c', { n: 4 });
  cards.clear();
  t.check('every card that waits starts a wait, and its going ends it, once each', seen, ['+a', '+b', '-a', '+c', '-b', '-c']);
  t.check('and it is still the map it was', [cards.size, new WaitsFor(() => undefined).set('x', 1).get('x')], [0, 1]);
}

{
  const start = new Date(T0).toISOString();
  const open = [{ from: new Date(T0 + 7 * min).toISOString() }];
  const at = (m: number): number => Math.floor(workedMs(start, open, T0 + m * min) / min);
  t.check('the page: the minutes stand still while paused', [at(5), at(7), at(9), at(30)], [5, 7, 7, 7]);
  const closed = [{ from: new Date(T0 + 7 * min).toISOString(), to: new Date(T0 + 12 * min).toISOString() }];
  t.check('and go on after Continue, less the pause', Math.floor(workedMs(start, closed, T0 + 15 * min) / min), 10);
  t.check('no start, nothing to count', workedMs(undefined, open, T0), 0);
}

t.finish();
