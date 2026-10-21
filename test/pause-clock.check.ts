/**
 * The clock stands still while the work is paused (operator, 2026-10-21: "when paused, the time must stop being
 * measured"): `Hold` keeps each pause from "Pause" to "Continue", the runner takes them off a task's minutes against
 * its limit, and the page takes them off the minutes it shows (web/lib/paused.ts) — the same arithmetic on both sides.
 * Held here: a pause going on counts to now; one before the task began counts only from its start; several add up;
 * the page's minutes do not move while paused.
 *
 *   npm run check:pause-clock
 */
import { Hold, pausedWithin } from '../src/orchestrator/hold.js';
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
