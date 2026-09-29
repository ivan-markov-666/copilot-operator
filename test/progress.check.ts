/**
 * The no-progress signals (src/orchestrator/progress.ts): a loop in which every round looks new.
 *
 *   npm run check:progress
 */
import { failureSignature, ProgressWatch, type StepEnd } from '../src/orchestrator/progress.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const fail = (stderr: string): StepEnd => ({ outcome: 'completed', exitCode: 1, stdout: '', stderr });
const ok: StepEnd = { outcome: 'completed', exitCode: 0, stdout: 'fine', stderr: '' };

console.log('--- the failure a round ended with ---');
t.check('a round with a success in it is not a failure', failureSignature([fail('boom'), ok]), null);
t.check('numbers do not make two errors different', failureSignature([fail('ECONNREFUSED 127.0.0.1:5432 after 31 ms')]), failureSignature([fail('ECONNREFUSED 127.0.0.1:5433 after 902 ms')]));
t.check('nor does spacing', failureSignature([fail('database   unreachable\r\n')]), failureSignature([fail('database unreachable')]));
t.check('a refused step is not a failure of the work', failureSignature([{ outcome: 'refused', exitCode: -4, stdout: '', stderr: 'x' }]), null);

console.log('\n--- the same error, round after round, nothing changed ---');
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  t.check('round 1', w.afterRound('T', [fail('database unreachable')]), null);
  t.check('round 2', w.afterRound('T', [fail('database unreachable')]), null);
  t.truthy('round 3 stops it', /3 rounds in a row ended with the same error/.test(w.afterRound('T', [fail('database unreachable')]) ?? ''));
}
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  w.afterRound('T1', [fail('database unreachable')]);
  w.afterRound('T2', [fail('database unreachable')]);
  t.check('a file changed in between: not stuck', w.afterRound('T3', [fail('database unreachable')]), null);
}
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  w.afterRound('T', [fail('database unreachable')]);
  w.afterRound('T', [ok]);
  w.afterRound('T', [fail('database unreachable')]);
  t.check('a round that succeeded resets the count', w.afterRound('T', [fail('database unreachable')]), null);
}
t.check('without a repository nothing is judged', new ProgressWatch({ noProgress: 2, oscillations: 1 }).afterRound(null, [fail('x')]), null);

console.log('\n--- changes made and undone ---');
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  t.check('A', w.afterRound('A', [ok]), null);
  t.check('B', w.afterRound('B', [ok]), null);
  t.check('A again: once', w.afterRound('A', [ok]), null);
  t.truthy('B again: stopped', /went back to how they were two rounds earlier 2 times/.test(w.afterRound('B', [ok]) ?? ''));
}
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  for (const tree of ['A', 'B', 'C', 'D']) w.afterRound(tree, [ok]);
  t.check('steady change is progress', w.afterRound('E', [ok]), null);
}

console.log('\n--- "done" again with the same failing checks ---');
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  const failing = [{ name: 'tests pass', detail: 'exit 1 after 12 tests' }];
  t.check('the first time is reported to the chat', w.afterFailedChecks('T', failing), null);
  t.truthy('the same again with nothing changed stops it', /done" was said again with the same 1 check/.test(w.afterFailedChecks('T', [{ name: 'tests pass', detail: 'exit 1 after 13 tests' }]) ?? ''));
}
{
  const w = new ProgressWatch({ noProgress: 3, oscillations: 2 });
  w.afterFailedChecks('T1', [{ name: 'tests pass', detail: 'exit 1' }]);
  t.check('with a file changed it goes on', w.afterFailedChecks('T2', [{ name: 'tests pass', detail: 'exit 1' }]), null);
}

t.finish();
