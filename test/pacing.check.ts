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
