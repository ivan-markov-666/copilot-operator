/**
 * Who `npm run update` is willing to take code from.
 *
 * The updater fetches commits from a remote, fast-forwards onto them, installs what the lockfile
 * names and then builds the result — and the thing it builds is the thing that runs commands on
 * this machine. Its trust boundary is therefore exactly one sentence long: whoever controls that
 * remote controls this bot. That sentence was true before this file existed and nowhere written
 * down, which is the part worth fixing. A company being asked to deploy this is entitled to know
 * what the update path trusts, and to be told when it changes.
 *
 * Three things, none of them clever:
 *
 *   pin the remote     The URL a checkout last updated from is recorded. If `origin` now points
 *                      somewhere else, the update stops and says both addresses. Trust on first
 *                      use: the first update records whatever is there, because there is nothing
 *                      to compare it with and pretending otherwise would only teach people to
 *                      pass the override. It catches the case that matters — a remote quietly
 *                      repointed at a fork — and it catches it before any code is pulled.
 *   signatures, if you have them   `--require-signed` refuses a HEAD that git cannot verify.
 *                      Off by default, because this project does not sign its commits and a check
 *                      that always fails is a check that gets removed. It is here so that an
 *                      organisation whose fork *is* signed can turn it on and have it mean
 *                      something.
 *   write down what happened       Every update appends a line: when, from where, which commit to
 *                      which. `data/` is per-install and git-ignored, so the record survives the
 *                      pull it describes.
 *
 * The honest limit, as everywhere else in this project: none of this verifies the *content* of
 * what arrives. A signed commit from a compromised maintainer is a signed commit. This narrows
 * "anything that can reach the network" to "whoever holds the remote this checkout was installed
 * from", and says so out loud rather than leaving it implied.
 */

/** Where the record of the last update lives, under the install's `data/`. */
export const UPDATE_LOG = 'update-log.jsonl';
export const REMOTE_PIN = 'update-remote';

/**
 * Whether the remote this checkout is about to pull from is the one it pulled from before.
 *
 * Compared after normalising the shapes of the same address that git treats as equal: a trailing
 * `.git`, a trailing slash, and the case of the host. A `https://` and an `ssh://` form of the
 * same repository are deliberately *not* treated as equal — they are different access paths with
 * different credentials, and somebody should look at that rather than have it waved through.
 */
export function normaliseRemote(url) {
  return String(url ?? '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * `first-use` when nothing was recorded, `same` when it matches, `changed` when it does not.
 * Returned rather than decided here, so the caller owns what each one costs.
 */
export function compareRemote(recorded, actual) {
  const a = normaliseRemote(recorded);
  const b = normaliseRemote(actual);
  if (!a) return 'first-use';
  return a === b ? 'same' : 'changed';
}

/** What to tell somebody whose remote has moved. Both addresses, and the two ways out. */
export function remoteChangedMessage(recorded, actual) {
  return [
    'this checkout last updated from a different remote.',
    '    recorded : ' + recorded,
    '    now      : ' + actual,
    'Whoever controls the remote controls what this bot runs, so this stops here.',
    'If you moved the repository on purpose, accept it with:  npm run update -- --accept-remote',
    'If you did not, do not run it: check `git remote -v` and find out who changed it.',
  ].join('\n[stop] ');
}

/**
 * Whether git could verify the signature on a commit.
 *
 * `git verify-commit` exits non-zero for an unsigned commit and for a bad signature alike, which
 * is the right behaviour for a gate and the wrong one for a message, so the two are told apart by
 * what it printed. An unsigned commit is the ordinary case and says so; a bad signature is the
 * alarming one and must not be reported as merely "unsigned".
 */
export function signatureVerdict(ok, stderr) {
  if (ok) return { ok: true, detail: 'the commit is signed and git could verify it' };
  const text = String(stderr ?? '').toLowerCase();
  if (text.includes('no signature') || text.trim() === '') {
    return { ok: false, detail: 'the commit is not signed' };
  }
  if (text.includes('bad signature') || text.includes('bad_signature')) {
    return { ok: false, detail: 'the commit carries a signature that does NOT verify — stop and find out why' };
  }
  return { ok: false, detail: 'git could not verify the signature: ' + String(stderr ?? '').trim().slice(0, 200) };
}

/** One line for the record. JSON so it can be read by something other than a person. */
export function updateRecord({ at, remote, from, to, incoming, signed }) {
  return JSON.stringify({
    at: at ?? new Date().toISOString(),
    remote: remote ?? '',
    from: from ?? '',
    to: to ?? '',
    commits: typeof incoming === 'number' ? incoming : 0,
    signatureChecked: signed ?? 'not-required',
  });
}
