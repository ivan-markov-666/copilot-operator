/**
 * Where the runner is running, and the one combination it refuses to be in.
 *
 * Three things are pinned here. That elevation is read from the integrity-level **SID** and not
 * from the English words beside it, because a check written against "High Mandatory Level" answers
 * "not elevated" on a translated Windows — wrong, in the unsafe direction. That a claim and a
 * signal which disagree are *reported* rather than silently resolved, since only a person can say
 * which of the two is wrong. And that unattended plus no isolation is refused outright: nobody
 * watching and nothing containing is the arrangement this whole round exists to make impossible.
 */
import {
  assessIsolation,
  describeIsolation,
  elevationFrom,
  readIsolationSignals,
  forgetIsolationSignals,
  unattendedIsolationRefusal,
  type IsolationSignals,
} from '../src/exec/isolation.js';
import { unattendedPrecondition } from '../src/exec/policy.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

console.log('--- elevation is read by SID, so it survives a translated Windows ---');
check('High integrity is elevated', elevationFrom('Mandatory Label\\High Mandatory Level S-1-16-12288'), true);
check('System integrity is elevated', elevationFrom('S-1-16-16384'), true);
check('Medium is not', elevationFrom('Mandatory Label\\Medium Mandatory Level S-1-16-8192'), false);
check('Low is not', elevationFrom('S-1-16-4096'), false);
check('a translated High is still elevated', elevationFrom('Задължителен етикет\\Високо ниво S-1-16-12288'), true);
check('no output is unknown, never "no"', elevationFrom(null), null);
check('output with no integrity SID is unknown', elevationFrom('some groups but no level'), null);

console.log('\n--- the signals are read from the environment ---');
forgetIsolationSignals();
const sandbox = readIsolationSignals({ USERNAME: 'WDAGUtilityAccount', COMPUTERNAME: 'BOX' }, () => 'S-1-16-8192', true);
check('Windows Sandbox is recognised', sandbox.windowsSandbox, true);
forgetIsolationSignals();
const ordinary = readIsolationSignals({ USERNAME: 'ivan', COMPUTERNAME: 'LAPTOP' }, () => 'S-1-16-8192', true);
check('an ordinary account is not', ordinary.windowsSandbox, false);
check('and is not elevated', ordinary.elevated, false);

const plain: IsolationSignals = { user: 'ivan', computer: 'LAPTOP', elevated: false, windowsSandbox: false };

console.log('\n--- no isolation is said plainly ---');
const none = assessIsolation('none', plain);
check('a concern is raised', none.warnings.length > 0, true);
check('naming what is at risk', none.warnings.some((w) => w.includes('ordinary user')), true);

console.log('\n--- a claim and a signal that disagree are reported, not resolved ---');
const lying = assessIsolation('sandbox', plain);
check('the contradiction is named', lying.warnings.some((w) => w.includes('One of the two is wrong')), true);
const honest = assessIsolation('sandbox', { ...plain, user: 'WDAGUtilityAccount', windowsSandbox: true });
check('an honest sandbox claim is quiet', honest.warnings.length, 0);
check('a separate account claim is quiet', assessIsolation('separate-account', plain).warnings.length, 0);

console.log('\n--- elevation is a concern whatever the claim ---');
check('elevated is flagged', assessIsolation('vm', { ...plain, elevated: true }).warnings.some((w) => w.includes('elevated')), true);
check('unknown elevation is flagged too', assessIsolation('vm', { ...plain, elevated: null }).warnings.some((w) => w.includes('could not be determined')), true);

console.log('\n--- unattended with no isolation is refused ---');
check('refused', unattendedIsolationRefusal('unattended', 'none') !== null, true);
check('confirm is not', unattendedIsolationRefusal('confirm', 'none'), null);
check('unattended in a sandbox is not', unattendedIsolationRefusal('unattended', 'sandbox'), null);
check('nor on a separate account', unattendedIsolationRefusal('unattended', 'separate-account'), null);

console.log('\n--- the description never upgrades a claim to a finding ---');
check('the claim is labelled as claimed', describeIsolation(none).includes('claimed'), true);
check('and the account is shown separately', describeIsolation(none).includes('account'), true);

console.log('\n--- the precondition every entrance asks, and the step gate asks again ---');
// The first version refused each step as it arrived, which held the line and turned the ordinary
// "Run sessions" button into a run where every step came back refused. The rule did not change;
// where it is asked did. These cases pin both the rule and the order of its two reasons.
const full = { allowedPrograms: ['node'], isolation: 'sandbox' as const };
check('confirm never has a precondition', unattendedPrecondition({ ...full, mode: 'confirm', isolation: 'none' }), null);
check('unattended, isolated and allowlisted, may begin', unattendedPrecondition({ ...full, mode: 'unattended' }), null);
const noIso = unattendedPrecondition({ ...full, mode: 'unattended', isolation: 'none' });
check('unattended with no isolation may not', noIso !== null, true);
check('and is told which setting', noIso !== null && noIso.includes('execution.isolation'), true);
const noProgs = unattendedPrecondition({ mode: 'unattended', allowedPrograms: [], isolation: 'sandbox' });
check('unattended with no allowlist may not', noProgs !== null, true);
check('and is told which setting', noProgs !== null && noProgs.includes('execution.allowedPrograms'), true);
const both = unattendedPrecondition({ mode: 'unattended', allowedPrograms: [], isolation: 'none' });
check('with both wrong, isolation is named first', both !== null && both.includes('execution.isolation'), true);
// A missing claim is the same as saying none: a config written before this existed does not get
// unattended runs for free.
check('an absent claim counts as none', unattendedPrecondition({ mode: 'unattended', allowedPrograms: ['node'] }) !== null, true);

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
