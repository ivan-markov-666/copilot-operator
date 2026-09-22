/**
 * Where this runner is running, and whether that is anywhere safe.
 *
 * Every other gate in this round is a rule about what a command may say. This one is about the
 * only thing that actually contains a command once it runs: the account it runs as. A deny list
 * refuses a phrasing; a separate low-privilege Windows account refuses a capability, and no
 * phrasing gets round it. The README has recommended one since before any of this, and the
 * recommendation has had no mechanism behind it at all — a machine that ignored it looked exactly
 * like a machine that had followed it, in the log and in the UI alike.
 *
 * What software can honestly do here is narrow, and pretending otherwise would be the worst
 * outcome, because somebody would rely on it. A process cannot certify its own isolation: it
 * cannot see the boundary it is inside, only the account it holds, and an attacker inside that
 * account sees the same thing it does. So this module does three separate things and keeps them
 * separate:
 *
 *   the claim      `execution.isolation` — what the operator says they have arranged. An
 *                  assertion, recorded as an assertion, never as a finding.
 *   the signals    the few facts that can be read cheaply and without being lied to by locale:
 *                  the account name, whether the process holds High or System integrity, and
 *                  whether the account is Windows Sandbox's own.
 *   the assessment where the two disagree, or where the combination is one nobody should be in.
 *
 * The one rule with teeth: an unattended run on a machine claiming no isolation is refused. That
 * combination — nobody watching, nothing containing — is the shape that put a security team on the
 * phone, and it is the one case where refusing costs a little and allowing costs everything.
 */
import { spawnSync } from 'node:child_process';

/** What the operator says they have arranged. An assertion, not a finding. */
export type IsolationClaim = 'none' | 'separate-account' | 'sandbox' | 'vm';

export type IsolationSignals = {
  user: string;
  computer: string;
  /**
   * High or System integrity — the process can change the machine. `null` when it could not be
   * determined, which is reported as unknown and never quietly as "no".
   */
  elevated: boolean | null;
  /** Windows Sandbox runs everything as its own account, which is a fact rather than a guess. */
  windowsSandbox: boolean;
};

export type IsolationPosture = {
  claim: IsolationClaim;
  signals: IsolationSignals;
  /** Contradictions and dangerous combinations, in the operator's language. */
  warnings: string[];
};

/** Windows Sandbox signs every process in it into this account. */
const SANDBOX_USER = 'wdagutilityaccount';

/*
 * Integrity level is carried as a well-known SID, and a SID is the same on every Windows in every
 * language. The text beside it is not: "High Mandatory Level" is translated, and a check written
 * against the English would answer "not elevated" on a Bulgarian machine — the wrong answer in the
 * unsafe direction, which is the one kind of wrong this must not be.
 */
const INTEGRITY_HIGH = 'S-1-16-12288';
const INTEGRITY_SYSTEM = 'S-1-16-16384';
const INTEGRITY_MEDIUM = 'S-1-16-8192';
const INTEGRITY_LOW = 'S-1-16-4096';

let cached: IsolationSignals | null = null;

/** `whoami /groups`, or null when it cannot be run. Separated so a test can supply its own. */
function whoamiGroups(): string | null {
  try {
    const r = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Reads the integrity level out of `whoami /groups` output by SID. Exported for the check. */
export function elevationFrom(groups: string | null): boolean | null {
  if (!groups) return null;
  if (groups.includes(INTEGRITY_SYSTEM) || groups.includes(INTEGRITY_HIGH)) return true;
  if (groups.includes(INTEGRITY_MEDIUM) || groups.includes(INTEGRITY_LOW)) return false;
  return null;
}

export function readIsolationSignals(
  env: NodeJS.ProcessEnv = process.env,
  groups: () => string | null = whoamiGroups,
  fresh = false,
): IsolationSignals {
  if (cached && !fresh) return cached;
  const user = env.USERNAME ?? '(unknown)';
  cached = {
    user,
    computer: env.COMPUTERNAME ?? '(unknown)',
    elevated: elevationFrom(groups()),
    windowsSandbox: user.toLowerCase() === SANDBOX_USER,
  };
  return cached;
}

/** For tests, which supply their own environment and must not read a cached answer. */
export function forgetIsolationSignals(): void {
  cached = null;
}

/**
 * The posture: the claim, the signals, and every way the two of them are worth remarking on.
 *
 * A contradiction is reported rather than resolved. If the operator says "sandbox" and the account
 * is not the sandbox's, this does not decide which is true — it says they disagree, because one of
 * them is wrong and only a person can say which.
 */
export function assessIsolation(claim: IsolationClaim, signals: IsolationSignals): IsolationPosture {
  const warnings: string[] = [];

  if (claim === 'none') {
    warnings.push(
      'this run is not isolated: commands written by the model run as the ordinary user, with that ' +
        "user's files, tokens and network access. Set execution.isolation once you have arranged a " +
        'separate low-privilege account, Windows Sandbox or a VM.',
    );
  }
  if (signals.elevated === true) {
    warnings.push(
      'this process is running elevated (High or System integrity), so every command it runs is ' +
        'elevated too. Nothing this runner does needs administrator rights; start it as an ordinary user.',
    );
  }
  if (signals.elevated === null) {
    warnings.push('whether this process is elevated could not be determined, so treat it as possibly elevated.');
  }
  if (claim === 'sandbox' && !signals.windowsSandbox) {
    warnings.push(
      `execution.isolation says "sandbox", but this process is running as ${signals.user}, which is not ` +
        "Windows Sandbox's own account. One of the two is wrong.",
    );
  }
  if (claim === 'separate-account' && signals.windowsSandbox) {
    warnings.push('execution.isolation says "separate-account", but this is Windows Sandbox. Say "sandbox" instead.');
  }

  return { claim, signals, warnings };
}

/**
 * Why an unattended run may not start here, or null.
 *
 * Nobody watching and nothing containing is the one combination this refuses outright. Either
 * side of it alone is a decision somebody can defend; together they are the arrangement that had
 * a security team asking whether an automation tool had been compromised, and the honest answer
 * at the time was that nothing would have looked any different if it had.
 */
export function unattendedIsolationRefusal(mode: 'confirm' | 'unattended', claim: IsolationClaim): string | null {
  if (mode !== 'unattended') return null;
  if (claim !== 'none') return null;
  return (
    'refused: an unattended run needs somewhere to run. With execution.isolation set to "none" there is ' +
    'nobody watching the steps and nothing limiting what they reach, which is the one combination this ' +
    'runner will not start. Run this task in confirm mode, or set execution.isolation once the bot has a ' +
    'separate low-privilege account, Windows Sandbox or a VM of its own.'
  );
}

/** The posture as lines for the task log and `cop doctor`. */
export function describeIsolation(p: IsolationPosture): string {
  return [
    `claimed     : ${p.claim}${p.claim === 'none' ? ' (the operator has not arranged any)' : ''}`,
    `account     : ${p.signals.user} on ${p.signals.computer}${p.signals.windowsSandbox ? ' (Windows Sandbox)' : ''}`,
    `elevated    : ${p.signals.elevated === null ? 'could not be determined' : p.signals.elevated ? 'YES — every command runs elevated' : 'no'}`,
    ...(p.warnings.length ? ['concerns    :', ...p.warnings.map((w) => `  - ${w}`)] : ['concerns    : none']),
  ].join('\n');
}
