/**
 * The per-run policy manifest: what was allowed, recorded beside what was run.
 *
 * The question this answers is the one the GSOC incident could not answer quickly — "what was this
 * tool permitted to do at the time" — so the properties worth pinning are the ones somebody would
 * rely on months later: that a turned-off allowlist is recorded as turned off rather than as an
 * empty list nobody reads twice, that the built-in floor carries a digest so a quiet edit to
 * `dangerous.ts` is visible, that a digest ignores reordering but not content, and that the
 * manifest never claims the run was isolated.
 */
import { collectPolicyManifest, describePolicyManifest, digestOf } from '../src/exec/policyManifest.js';
import { DANGEROUS_TECHNIQUES } from '../src/exec/dangerous.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const env = { USERNAME: 'ivan', USERDOMAIN: 'CORP', COMPUTERNAME: 'LAPTOP-01' } as NodeJS.ProcessEnv;
const base = {
  mode: 'confirm' as const,
  allowedPrograms: ['node', 'npm', 'git'],
  allowRunningDownloads: false,
  allowedScriptExtensions: ['.ps1'],
  denyPatterns: ['a', 'b'],
  cwd: 'C:\\Projects\\thing',
};

console.log('--- a digest ignores order but not content ---');
check('reordering is the same policy', digestOf(['a', 'b', 'c']), digestOf(['c', 'a', 'b']));
check('a different entry is a different policy', digestOf(['a', 'b']) === digestOf(['a', 'z']), false);
check('whitespace and blanks do not change it', digestOf([' a ', 'b', '']), digestOf(['a', 'b']));

console.log('\n--- the safe posture is recorded as such ---');
const safe = collectPolicyManifest(base, env);
check('allowlist enforced', safe.allowlist.enforced, true);
check('counted', safe.allowlist.count, 3);
check('downloads cannot run', safe.downloads.mayRun, false);
check('the account is recorded', safe.account.user, 'ivan');
check('the working directory is recorded', safe.cwd, 'C:\\Projects\\thing');

console.log('\n--- an empty allowlist is recorded as NOT enforced, not as an empty list ---');
const open = collectPolicyManifest({ ...base, allowedPrograms: [], mode: 'unattended', allowRunningDownloads: true }, env);
check('not enforced', open.allowlist.enforced, false);
check('and the prose says so plainly', describePolicyManifest(open).includes('NOT ENFORCED'), true);
check('unattended is named as unwatched', describePolicyManifest(open).includes('no person saw the steps'), true);
check('and that downloads could execute', describePolicyManifest(open).includes('COULD be executed'), true);

console.log('\n--- the built-in floor is fingerprinted ---');
check('every technique is counted', safe.builtIn.count, DANGEROUS_TECHNIQUES.length);
check('and digested', safe.builtIn.digest, digestOf(DANGEROUS_TECHNIQUES.map((t) => t.name)));
check('a changed floor is a changed digest', safe.builtIn.digest === digestOf([...DANGEROUS_TECHNIQUES.map((t) => t.name), 'something-new']), false);

console.log('\n--- it does not claim what it cannot know ---');
check('isolation is explicitly undetermined', safe.isolation.includes('not determined here'), true);
check('and the prose repeats it', describePolicyManifest(safe).includes('not determined here'), true);

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
