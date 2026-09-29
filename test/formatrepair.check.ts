/**
 * A reply in the wrong shape (src/protocol/parser.ts): prose fields read as text whatever shape
 * they arrive in, the fields that are acted on never guessed at, and a message back that says
 * exactly what to fix.
 *
 *   npm run check:formatrepair
 */
import { formatErrorMessage, parseReply, type ParseFail } from '../src/protocol/parser.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const opts = { stopMarker: 'Край', defaultShell: 'pwsh' as const };
const fenced = (v: unknown): string => '```json\n' + JSON.stringify(v, null, 2) + '\n```';
const summary = 'The dependency cannot be installed from this machine, so the build cannot run; everything else is in place.';

console.log('--- the case that failed a task: "tried" as a list of objects ---');
{
  const r = parseReply(
    fenced({
      status: 'blocked',
      summary,
      tried: [
        { approach: 'npm install with the lock file', result: 'ETIMEDOUT from the registry' },
        { approach: 'npm install --prefer-offline', result: 'the cache does not have the package' },
      ],
      needed: { what: 'network access to the npm registry' },
    }),
    opts,
  );
  t.check('accepted, not sent back', r.ok, true);
  if (r.ok) {
    t.check('as blocked', r.blocked, true);
    t.check('each approach read as a sentence', r.reply.tried, [
      'npm install with the lock file — ETIMEDOUT from the registry',
      'npm install --prefer-offline — the cache does not have the package',
    ]);
    t.check('"needed" read as text too', r.reply.needed, 'network access to the npm registry');
    t.check('and what was read that way is reported', r.coerced, ['needed', 'tried.0', 'tried.1']);
  }
}
{
  const r = parseReply(fenced({ status: 'continue', notes: ['first', 'second'], steps: [{ id: 1, type: 'command', cmd: 'npm test' }] }), opts);
  t.check('notes as a list: joined', r.ok && r.reply.notes, 'first\nsecond');
  const one = parseReply(fenced({ status: 'blocked', summary, tried: 'only one sentence' }), opts);
  t.check('a single string where a list belongs is still one approach, so blocked still needs two', one.ok, false);
}

console.log('\n--- what is acted on is never guessed at ---');
{
  const r = parseReply(fenced({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: ['npm', 'test'] }] }), opts);
  t.check('a command in the wrong shape is refused', r.ok, false);
  t.check('with the field named', !r.ok && (r as ParseFail).paths?.includes('steps.0.cmd'), true);
  const s = parseReply(fenced({ status: 'finished', summary }), opts);
  t.check('so is a status that is not one of the three', s.ok, false);
}

console.log('\n--- the message that asks for it again ---');
{
  const r = parseReply(fenced({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: ['npm', 'test'] }] }), opts) as ParseFail;
  const message = formatErrorMessage(r, 1, 2);
  t.truthy('says which field and what it must be', message.includes('steps.0.cmd') && message.includes('"steps" is a list of {"id": 1, "type": "command", "cmd": "the command"}'), message);
  t.truthy('says nothing from the reply was run and the earlier results stand', /Nothing from that reply was run, and the results of the steps before it stand/.test(message), message);
  t.truthy('asks for the same answer reformatted, not a new start', /same answer again, reformatted/.test(message) && /do not start over/.test(message), message);
  t.truthy('and carries a valid example', message.includes('{"status": "continue"') && message.includes('```json'), message);
}

t.finish();
