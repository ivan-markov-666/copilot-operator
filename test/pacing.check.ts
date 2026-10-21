import { Pacer } from '../src/util/pacing.js';

const p = new Pacer({ seed: 42 });
console.log('settle disabled :', await new Pacer({ enabled: false }).settle(), 'ms');
console.log('settle enabled  :', await new Pacer({ settleMs: 50 }).settle(), 'ms');
console.log('backoff         :', [0, 1, 2, 3, 4, 5].map((i) => p.backoffFor(i)).join(', '));
const a = new Pacer({ seed: 7 }).backoffFor(3);
const b = new Pacer({ seed: 7 }).backoffFor(3);
console.log('deterministic   :', a === b, a);

const cap = new Pacer({ maxMessagesPerHour: 3 });
for (let i = 0; i < 3; i++) console.log('send', i + 1, '-> waited', await cap.throttleSend(), 'ms');

// The 4th send must wait out the window. Abort it instead of sleeping for an hour.
const ac = new AbortController();
const pending = cap.throttleSend(ac.signal).then(() => 'did not wait').catch(() => 'waited, then aborted');
setTimeout(() => ac.abort(), 100);
console.log('send 4          ->', await pending);

/*
 * The pause between messages (operator, 2026-10-21): "a message sent, the next no sooner than 60 seconds after; and a
 * random time, between 60 and 90, say". Held across every pacer — the lead's and the worker's are two — and cut short
 * by Stop. Milliseconds here stand for the seconds of Settings.
 */
{
  const { Tally } = await import('./support/harness.js');
  const { forgetLastSend, gapFrom } = await import('../src/util/pacing.js');
  const t = new Tally();
  console.log('\n--- the pause between messages ---');
  t.check('off unless ticked', gapFrom({ gapEnabled: false, gapSec: 60 }), undefined);
  t.check('ticked: the shortest time, as milliseconds', gapFrom({ gapEnabled: true, gapSec: 60, gapRandom: false, gapMaxSec: 90 }), [60_000, 60_000]);
  t.check('with a random time: up to the longest', gapFrom({ gapEnabled: true, gapSec: 60, gapRandom: true, gapMaxSec: 90 }), [60_000, 90_000]);
  t.check('a longest under the shortest counts as the shortest', gapFrom({ gapEnabled: true, gapSec: 60, gapRandom: true, gapMaxSec: 30 }), [60_000, 60_000]);

  forgetLastSend();
  const told: number[] = [];
  const lead = new Pacer({ gapMs: [300, 300], onGap: (ms) => told.push(ms) });
  const worker = new Pacer({ gapMs: [300, 300] });
  const t0 = Date.now();
  await lead.throttleSend();
  t.truthy('the first message does not wait', Date.now() - t0 < 100, Date.now() - t0);
  await worker.throttleSend();
  const second = Date.now() - t0;
  t.truthy('the next one, from another pacer, waits the pause', second >= 280, second);
  await lead.throttleSend();
  t.truthy('and the one after it again, and it is said before it waits', Date.now() - t0 >= 580 && told.length === 1 && told[0]! > 250, { ms: Date.now() - t0, told });

  forgetLastSend();
  const random = new Pacer({ gapMs: [100, 400], seed: 3 });
  const gaps: number[] = [];
  await random.throttleSend();
  for (let i = 0; i < 4; i++) {
    const s = Date.now();
    await random.throttleSend();
    gaps.push(Date.now() - s);
  }
  t.truthy('a random time: each between the shortest and the longest, and not all the same', gaps.every((g) => g >= 90 && g <= 460) && new Set(gaps.map((g) => Math.round(g / 30))).size > 1, gaps);

  forgetLastSend();
  const stoppable = new Pacer({ gapMs: [60_000, 60_000] });
  await stoppable.throttleSend();
  const ac2 = new AbortController();
  const s2 = Date.now();
  const outcome = stoppable.throttleSend(ac2.signal).then(() => 'sent', () => 'stopped');
  setTimeout(() => ac2.abort(), 50);
  t.check('Stop cuts a wait for the pause short', [await outcome, Date.now() - s2 < 1000], ['stopped', true]);
  forgetLastSend();
  t.finish();
}
