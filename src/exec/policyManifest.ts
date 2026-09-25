/**
 * What was allowed, written down once per task, next to what was run.
 *
 * This exists because of a question nobody could answer quickly. A security team saw
 * `certutil.exe` decoding a blob on an operator's workstation with this runner in the process
 * tree, and asked the two reasonable things: what is this tool permitted to do, and was this
 * deliberate. The run folder held every command and every exit code — excellent evidence of what
 * happened — and nothing at all about what the rules had been at the time. So the answer had to be
 * reconstructed from a config file that had been edited since, which is not an answer.
 *
 * A manifest fixes that by recording the policy beside the run it governed: the mode, the
 * allowlist, whether downloaded files could execute, how many deny patterns and built-in refusals
 * were in force, and who the process was running as. Lists are recorded by count and digest as
 * well as in full, so "was this the same policy as last Tuesday" is one comparison rather than a
 * reading exercise, and a quietly edited `dangerous.ts` shows up as a changed digest.
 *
 * What it deliberately does not claim: that the run was isolated. Whether this process sits in a
 * sandbox or a separate low-privilege account is the operator's assertion to make, not something
 * software can honestly detect from the inside, so the manifest records the account it sees and
 * says plainly that isolation is not determined here. A manifest that overstated its own evidence
 * would be worse than none, because somebody would rely on it.
 */
import { createHash } from 'node:crypto';

import { DANGEROUS_TECHNIQUES } from './dangerous.js';
import { describeIsolation, type IsolationPosture } from './isolation.js';

export type PolicyManifest = {
  collectedAt: string;
  /** Whether a person saw each step. */
  mode: 'confirm' | 'unattended';
  allowlist: { enforced: boolean; count: number; digest: string; programs: string[] };
  /**
   * Whether a file the chat provided could be executed.
   *
   * A constant, and recorded anyway. It is the first question a security team asks of a tool like
   * this, and "the protocol has no file step" is a far better answer than the field being absent
   * and the reader having to work out whether that means no or means nobody wrote it down.
   */
  chatFiles: 'the chat cannot supply a file: this runner has no file step and executes nothing it did not receive as a command';
  denyPatterns: { count: number; digest: string };
  /** The built-in floor, which no configuration can switch off. A changed digest is a changed floor. */
  builtIn: { count: number; digest: string; names: string[] };
  /** Whether an administrator's `policy.lock.json` was in force, and what it tightened. */
  lock: { applied: boolean; changes: string[] };
  account: { user: string; domain: string; computer: string };
  /**
   * What contained this run: what the operator claimed, the few facts that could be read, and
   * where the two disagree. A claim is recorded as a claim — the manifest never upgrades it to a
   * finding, because a process cannot see the boundary it is inside. See `isolation.ts`.
   */
  isolation: IsolationPosture;
  cwd: string;
  /** The folders every command of this run was confined to. See `confinement.ts`. */
  confinedTo: string[];
};

/** A short, stable digest of a list, order-independent so a reordered config is not a changed one. */
export function digestOf(values: string[]): string {
  // JSON rather than a separator character: unambiguous for any entry, and free of the control
  // byte an earlier version joined on, which made this file read as binary to grep and every
  // other tool that decides by looking for one.
  const canonical = JSON.stringify([...values].map((v) => v.trim()).filter(Boolean).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export type ManifestInput = {
  mode: 'confirm' | 'unattended';
  allowedPrograms: string[];
  denyPatterns: string[];
  cwd: string;
  lock?: { applied: boolean; changes: string[] };
  isolation: IsolationPosture;
  /** The project folders commands were held to; empty when there was no project to hold them to. */
  confinedTo?: string[];
};

export function collectPolicyManifest(input: ManifestInput, env: NodeJS.ProcessEnv = process.env): PolicyManifest {
  const names = DANGEROUS_TECHNIQUES.map((t) => t.name);
  return {
    collectedAt: new Date().toISOString(),
    mode: input.mode,
    allowlist: {
      // An empty list is the gate turned off, and that is the fact worth recording plainly: it is
      // the difference between "only these programs" and "any program at all".
      enforced: input.allowedPrograms.length > 0,
      count: input.allowedPrograms.length,
      digest: digestOf(input.allowedPrograms),
      programs: [...input.allowedPrograms],
    },
    chatFiles: 'the chat cannot supply a file: this runner has no file step and executes nothing it did not receive as a command',
    denyPatterns: { count: input.denyPatterns.length, digest: digestOf(input.denyPatterns) },
    builtIn: { count: names.length, digest: digestOf(names), names },
    lock: input.lock ?? { applied: false, changes: [] },
    account: {
      user: env.USERNAME ?? '(unknown)',
      domain: env.USERDOMAIN ?? '(unknown)',
      computer: env.COMPUTERNAME ?? '(unknown)',
    },
    isolation: input.isolation,
    cwd: input.cwd,
    confinedTo: [...(input.confinedTo ?? [])],
  };
}

/** The manifest as a block of `name : value` lines, for the task log, beside the environment. */
export function describePolicyManifest(m: PolicyManifest): string {
  return [
    `mode        : ${m.mode}${m.mode === 'unattended' ? ' (no person saw the steps as they ran)' : ' (a person approved each step)'}`,
    `allowlist   : ${m.allowlist.enforced ? `${m.allowlist.count} programs, digest ${m.allowlist.digest}` : 'NOT ENFORCED — any program could be started'}`,
    `chat files : ${m.chatFiles}`,
    `deny list   : ${m.denyPatterns.count} patterns, digest ${m.denyPatterns.digest}`,
    `built-in    : ${m.builtIn.count} refused techniques, digest ${m.builtIn.digest} (cannot be switched off)`,
    `lock        : ${
      m.lock.applied
        ? m.lock.changes.length
          ? `policy.lock.json in force — ${m.lock.changes.join('; ')}`
          : 'policy.lock.json in force — nothing to tighten'
        : 'none — this machine has no administrator policy file'
    }`,
    `account     : ${m.account.domain}\\${m.account.user} on ${m.account.computer}`,
    'isolation   :',
    describeIsolation(m.isolation).split('\n').map((l) => `  ${l}`).join('\n'),
    `cwd         : ${m.cwd}`,
    `confined to : ${m.confinedTo.length ? m.confinedTo.join(', ') : 'NOTHING — commands were not held to a project'}`,
    `collected   : ${m.collectedAt}`,
  ].join('\n');
}
