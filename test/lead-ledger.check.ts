/**
 * The lead's list of subtasks (operator's feedback, 2026-10-21: "1 of 20 subtasks" read as if twenty were planned):
 * how a reply's `todo` is read, and how the runner keeps the list (src/orchestrator/leadLedger.ts). Held here:
 *
 * - a list is read in the words a chat uses for the statuses, and as lines when it came as text; a subtask or a plan
 *   without one is refused with the shape it must have, a question or the result is not;
 * - the subtask given now is the list's running one — found by its title however it is spelt, or the one marked
 *   running, or put in where the planned ones begin — and exactly one runs;
 * - the version goes up when subtasks come, go or change order, not when one moves on; what changed is kept;
 * - a subtask keeps its number from list to list; with no list in a reply, the one before stands; the end closes the
 *   running one; the lead is shown its list with the counts and the limit apart.
 *
 *   npm run check:lead-ledger
 */
import { LeadReplySchema } from '../src/protocol/leadSchema.js';
import { closeLedger, describeLedger, ledgerCounts, nextLedger, sameTitle } from '../src/orchestrator/leadLedger.js';
import type { LeadLedger } from '../src/session/model.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const AT = '2026-10-21T12:00:00.000Z';
const SUB = { title: 'Survey the project', goal: 'Find out what is in the project folder.', report: 'The files at the root, one per line.' };

{
  const read = LeadReplySchema.safeParse({ status: 'delegate', subtask: SUB, todo: [{ title: 'Survey the project', status: 'in_progress' }, { title: 'Fix it', status: 'pending' }, { title: 'Check it', status: 'completed', phase: 'Verify' }, 'Report back'] });
  t.check(
    'the statuses in the words a chat uses, a bare title as planned',
    read.success ? read.data.todo?.map((i) => [i.title, i.status, i.phase ?? null]) : read.error.issues,
    [['Survey the project', 'running', null], ['Fix it', 'planned', null], ['Check it', 'done', 'Verify'], ['Report back', 'planned', null]],
  );
  const text = LeadReplySchema.safeParse({ status: 'plan', plan: { existing: 'A README.', approach: 'Write it.', steps: ['write'], files: [], verification: 'Read it back.' }, todo: '1. Write it\n2. Read it back' });
  t.check('a list that came as lines of text', text.success ? text.data.todo?.map((i) => i.title) : text.error.issues, ['Write it', 'Read it back']);
  const none = LeadReplySchema.safeParse({ status: 'delegate', subtask: SUB });
  t.truthy('a subtask without the list is refused, with the shape it must have', !none.success && none.error.issues.some((i) => i.path.join('.') === 'todo' && i.message.includes('"running"')), none.success ? 'accepted' : none.error.issues);
  const planNone = LeadReplySchema.safeParse({ status: 'plan', plan: { existing: 'A README.', approach: 'Write it.', steps: ['write'], files: [], verification: 'Read it back.' } });
  t.check('so is a plan without it', planNone.success, false);
  t.check('a question needs none', LeadReplySchema.safeParse({ status: 'ask', question: 'Which of the two folders is meant here?' }).success, true);
  const bad = LeadReplySchema.safeParse({ status: 'delegate', subtask: SUB, todo: [{ title: 'Survey the project', status: 'maybe' }] });
  t.truthy('a status that is none of the five is said', !bad.success && bad.error.issues.some((i) => i.message.includes('"done", "running", "planned", "blocked", "failed"')), bad.success ? 'accepted' : bad.error.issues);
}

t.check('titles the same, spelt otherwise', [sameTitle('1. Survey the project', 'survey the project!'), sameTitle('Fix', 'Fix the tests'), sameTitle('Run the whole test suite', 'run the whole test suite once')], [true, false, true]);

{
  const first = nextLedger(undefined, [{ title: 'Survey the project', status: 'planned' }, { title: 'Plan the work', status: 'planned' }], AT, { title: 'survey the project', n: 1 });
  t.check('the first list: version 1, the subtask given now running with its number', [first.ledger?.revision, first.ledger?.items.map((i) => [i.status, i.n ?? null]), first.change], [1, [['running', 1], ['planned', null]], { revision: 1, added: 2, removed: 0, total: 2 }]);

  const two = nextLedger(first.ledger, [{ title: 'Survey the project', status: 'running' }, { title: 'Write the file', status: 'running' }, { title: 'Read it back', status: 'planned' }], AT, { title: 'Write the file', n: 2 });
  t.check(
    'one running: the one given now; the other set back; numbers kept',
    two.ledger?.items.map((i) => [i.title, i.status, i.n ?? null]),
    [['Survey the project', 'planned', 1], ['Write the file', 'running', 2], ['Read it back', 'planned', null]],
  );
  t.check('subtasks came and one went: a new version, and what changed', [two.change, two.ledger?.added, two.ledger?.removed], [{ revision: 2, added: 2, removed: 1, total: 3 }, ['Write the file', 'Read it back'], ['Plan the work']]);

  const moved = nextLedger(two.ledger, [{ title: 'Survey the project', status: 'done' }, { title: 'Write the file', status: 'done' }, { title: 'Read it back', status: 'running' }], AT, { title: 'Read it back', n: 3 });
  t.check('a status moving on is progress: the same version, no change, the last change kept', [moved.ledger?.revision, moved.change ?? null, moved.ledger?.added], [2, null, ['Write the file', 'Read it back']]);

  const reordered = nextLedger(moved.ledger, [{ title: 'Read it back', status: 'running' }, { title: 'Survey the project', status: 'done' }, { title: 'Write the file', status: 'done' }], AT);
  t.check('another order is another plan', reordered.change, { revision: 3, added: 0, removed: 0, total: 3 });

  const unnamed = nextLedger(moved.ledger, [{ title: 'Survey the project', status: 'done' }, { title: 'Write the file', status: 'done' }, { title: 'Report', status: 'planned' }], AT, { title: 'Read the file back once more', n: 4 });
  t.check('the subtask given, not in the list: put in where the planned ones begin', unnamed.ledger?.items.map((i) => [i.title, i.status]), [['Survey the project', 'done'], ['Write the file', 'done'], ['Read the file back once more', 'running'], ['Report', 'planned']]);

  t.check('no list in the reply: the one before stands', nextLedger(moved.ledger, undefined, AT).ledger, moved.ledger);
  const closed = closeLedger(moved.ledger, 'done');
  t.check('delivered: the running one is done', closed?.items.map((i) => i.status), ['done', 'done', 'done']);
  t.check('could not: blocked', closeLedger(moved.ledger, 'blocked')?.items.map((i) => i.status), ['done', 'done', 'blocked']);

  const l: LeadLedger = { revision: 4, at: AT, items: [{ title: 'A one', status: 'done', phase: 'Survey' }, { title: 'B two', status: 'failed' }, { title: 'C three', status: 'running', phase: 'Fix' }, { title: 'D four', status: 'planned' }] };
  t.check('the counts: where the work is, against the plan', ledgerCounts(l), { total: 4, done: 1, running: 1, planned: 1, stuck: 1, current: 3 });
  const told = describeLedger(l, 3, 20);
  t.truthy(
    'the lead is shown its list, the counts and the limit apart',
    told.startsWith('Your list of subtasks (version 4): 1 done, 1 running, 1 planned, 1 blocked or failed. Subtasks given so far: 3; at most 20 may be given.') && told.includes('3. [running] C three — Fix') && told.includes('2. [failed] B two'),
    told,
  );
}

t.finish();
