/**
 * What `npm run update` is willing to take code from.
 *
 * The updater pulls commits, installs what the lockfile names and builds the result, and that
 * result is what runs commands on this machine — so the remote is the trust boundary, entire. The
 * properties worth pinning are the ones a deployment would lean on: that a remote which has
 * changed stops the update *before* anything is fetched, that the shapes of the same address git
 * treats as equal do not cause a false alarm, that two different access paths to one repository
 * are not waved through, and that an unsigned commit and a bad signature are never reported as the
 * same thing.
 */
// @ts-expect-error — a plain .mjs helper, deliberately outside the TypeScript build because the
// updater has to run before anything is built.
import { compareRemote, normaliseRemote, readLockFile, remoteChangedMessage, signatureVerdict, updateRecord } from '../scripts/updateTrust.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const GH = 'https://github.com/ivan-markov-666/copilot-operator';

console.log('--- the shapes git treats as one address are one address ---');
check('a trailing .git is the same', normaliseRemote(`${GH}.git`), normaliseRemote(GH));
check('a trailing slash is the same', normaliseRemote(`${GH}/`), normaliseRemote(GH));
check('case of the host is the same', normaliseRemote(GH.toUpperCase()), normaliseRemote(GH));

console.log('\n--- but a different access path is a different thing to look at ---');
// Not an equality bug: https and ssh carry different credentials, and somebody swapping one for
// the other is a change worth a person's eye rather than one to wave through.
check('ssh and https are not silently equal', compareRemote(GH, 'git@github.com:ivan-markov-666/copilot-operator.git'), 'changed');

console.log('\n--- the verdict ---');
check('nothing recorded is first use', compareRemote('', GH), 'first-use');
check('undefined is first use too', compareRemote(undefined, GH), 'first-use');
check('the same remote is the same', compareRemote(GH, `${GH}.git`), 'same');
check('a fork is a change', compareRemote(GH, 'https://github.com/someone-else/copilot-operator'), 'changed');

console.log('\n--- and it says both addresses and the way out ---');
const msg = remoteChangedMessage(GH, 'https://github.com/someone-else/copilot-operator');
check('the old one', msg.includes(GH), true);
check('the new one', msg.includes('someone-else'), true);
check('what it means', msg.includes('controls what this bot runs'), true);
check('how to accept it deliberately', msg.includes('--accept-remote'), true);

console.log('\n--- an unsigned commit and a bad signature are not the same news ---');
check('verified', signatureVerdict(true, '').ok, true);
check('unsigned is refused', signatureVerdict(false, 'gpg: no signature found').ok, false);
check('and called unsigned', signatureVerdict(false, 'gpg: no signature found').detail.includes('not signed'), true);
check('an empty complaint is also just unsigned', signatureVerdict(false, '').detail.includes('not signed'), true);
const bad = signatureVerdict(false, 'gpg: BAD signature from "someone"');
check('a bad signature is refused', bad.ok, false);
check('and is NOT called merely unsigned', bad.detail.includes('not signed'), false);
check('it is called out', bad.detail.includes('does NOT verify'), true);

console.log('\n--- the record is machine-readable and carries the trust facts ---');
const line = JSON.parse(updateRecord({ at: '2026-09-22T12:00:00.000Z', remote: GH, from: 'aaa', to: 'bbb', incoming: 3, signed: 'verified' })) as Record<string, unknown>;
check('when', line.at, '2026-09-22T12:00:00.000Z');
check('from where', line.remote, GH);
check('which commit to which', `${String(line.from)}->${String(line.to)}`, 'aaa->bbb');
check('how many came in', line.commits, 3);
check('whether a signature was demanded', line.signatureChecked, 'verified');
check('and it defaults to not-required', (JSON.parse(updateRecord({})) as Record<string, unknown>).signatureChecked, 'not-required');

/*
 * The policy lock as the updater reads it: only a missing file is no lock, and a lock Windows
 * PowerShell 5.1 saved, with a byte-order mark or as UTF-16, is read. The updater used to report a
 * lock it could not open as "not valid JSON", and refused one with a mark as just that.
 */
console.log('\n--- the policy lock, as the updater reads it ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'cop-update-lock-'));
  const lock = join(dir, 'policy.lock.json');
  const text = JSON.stringify({ update: { requireSigned: true } });
  const errorOf = (run: () => unknown): string => {
    try {
      run();
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };
  try {
    check('no file is no lock', readLockFile(lock, readFileSync), null);
    writeFileSync(join(dir, 'nope'), 'a file, not a folder', 'utf8');
    check('nor is a path through a file, where no lock can be', readLockFile(join(dir, 'nope', 'policy.lock.json'), readFileSync), null);
    const encodings: Array<[string, Buffer]> = [
      ['UTF-8', Buffer.from(text, 'utf8')],
      ['UTF-8 with a byte-order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])],
      ['UTF-16 little-endian, as > writes it', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
      ['UTF-16 big-endian', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
    ];
    for (const [how, bytes] of encodings) {
      writeFileSync(lock, bytes);
      check(`a lock saved as ${how} is read`, JSON.stringify(readLockFile(lock, readFileSync)), text);
    }
    writeFileSync(lock, '{ "update": { "requireSigned": true }, }', 'utf8');
    check('a lock that does not parse is refused as not valid JSON', /policy\.lock\.json is not valid JSON/.test(errorOf(() => readLockFile(lock, readFileSync))), true);
    rmSync(lock);
    mkdirSync(lock);
    const folder = errorOf(() => readLockFile(lock, readFileSync));
    check('a folder where the lock should be is refused, as could not be read', /policy\.lock\.json could not be read/.test(folder), true);
    check('and not called invalid JSON', folder.includes('not valid JSON'), false);
    const denied = errorOf(() => readLockFile(lock, () => {
      throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
    }));
    check('a lock this account may not read is refused, as could not be read', /policy\.lock\.json could not be read: EPERM/.test(denied), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
