/**
 * The policy an administrator sets and the operator cannot loosen.
 *
 * `data/settings.json` belongs to whoever is sitting at the machine, and that is right for almost
 * everything in it. It is wrong for the part that decides what this tool may run, because the
 * person at the machine is also the person under time pressure to get a run finished, and because
 * a company deploying this to a fleet needs to state a floor that a local edit cannot go under.
 * Without that, "the allowlist is enforced" is a sentence about one machine on one afternoon.
 *
 * So a deployment may ship `policy.lock.json` beside the configuration. Every field is optional
 * and every field can only *tighten*:
 *
 *   maxMode                  `confirm` forbids unattended runs outright.
 *   allowedPrograms          a ceiling: the effective list is the intersection with the operator's,
 *                            and an operator who empties their own list gets the lock's rather than
 *                            the gate switched off, because empty means "no allowlist" and that is
 *                            the one direction a lock must never permit.
 *   denyPatterns             a floor: merged in, so a lock pattern cannot be deleted locally.
 *
 * The runner never writes this file. There is no API route that edits it and no UI that shows it
 * as editable; it is placed by whoever administers the machine, and on a machine that has none
 * nothing changes, so an existing install keeps working exactly as before.
 *
 * The honest limit, again: a local administrator can delete the file, and this is not protection
 * against the machine's owner. It is protection against the ordinary drift — a setting widened for
 * one task and never put back — and it gives a security team a single artefact to point at.
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolationClaim } from '../exec/isolation.js';

export const POLICY_LOCK_FILE = 'policy.lock.json';

export const PolicyLockSchema = z
  .object({
    maxMode: z.enum(['confirm', 'unattended']).optional(),
    allowedPrograms: z.array(z.string()).optional(),
    denyPatterns: z.array(z.string()).optional(),
    /** `true` treats the claim `none-accepted` as `none`: unattended runs need real isolation here. */
    requireIsolation: z.boolean().optional(),
    /**
     * Still read, so a lock written for an earlier version is not refused; they lock nothing now.
     * The project was once copied to the Desktop and attached to the chat, and these switched that,
     * and its `.env` files, off. That feature was removed on 2026-09-30.
     */
    allowDesktopMirror: z.boolean().optional(),
    allowEnvFiles: z.boolean().optional(),
    /** A ceiling on `execution.passEnv`: the only variables a step may be given beyond the fixed set. */
    passEnv: z.array(z.string()).optional(),
    /** What `npm run update` must insist on: signed commits, and one remote no flag can override. */
    update: z
      .object({
        requireSigned: z.boolean().optional(),
        remote: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PolicyLock = z.infer<typeof PolicyLockSchema>;

/** The parts of the configuration a lock governs. The optional ones are absent in a test of the first three. */
export type LockablePolicy = {
  mode: 'confirm' | 'unattended';
  allowedPrograms: string[];
  denyPatterns: string[];
  isolation?: IsolationClaim;
  passEnv?: string[];
};

/** What the lock changed, so the run log and the manifest can say it rather than imply it. */
export type LockOutcome = {
  applied: boolean;
  changes: string[];
  /**
   * The lock's ceiling on the mode, carried to every place a run is started or switched. Rewriting
   * `execution.mode` alone was not enough: the API takes the mode from the request, so a lock that
   * said `confirm` never stopped the unattended button (found 2026-09-27).
   */
  maxMode?: 'confirm' | 'unattended';
};

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean));
}

/**
 * A ceiling list: the operator's entries that the lock also permits. An empty operator list is
 * treated as "unset" rather than as "allow nothing", because for `allowedPrograms` an empty list
 * turns the gate off — the loosest setting there is — and a ceiling that could be escaped by
 * clearing the field would not be a ceiling.
 */
function intersect(operator: string[], ceiling: string[]): string[] {
  if (operator.length === 0) return [...ceiling];
  const allowed = lowerSet(ceiling);
  return operator.filter((v) => allowed.has(v.trim().toLowerCase()));
}

/** Applies a lock to a policy, returning the tightened policy and what it changed. */
export function applyPolicyLock(policy: LockablePolicy, lock: PolicyLock | null): { policy: LockablePolicy; outcome: LockOutcome } {
  if (!lock) return { policy, outcome: { applied: false, changes: [] } };
  const changes: string[] = [];
  const next: LockablePolicy = { ...policy };

  if (lock.maxMode === 'confirm' && next.mode !== 'confirm') {
    next.mode = 'confirm';
    changes.push('mode forced to confirm (the lock forbids unattended runs)');
  }

  if (lock.allowedPrograms) {
    const before = next.allowedPrograms;
    next.allowedPrograms = intersect(before, lock.allowedPrograms);
    if (before.length === 0) changes.push(`allowlist enforced with the lock's ${next.allowedPrograms.length} programs (it was switched off locally)`);
    else if (next.allowedPrograms.length !== before.length) {
      changes.push(`allowlist narrowed from ${before.length} to ${next.allowedPrograms.length} programs`);
    }
  }

  if (lock.denyPatterns?.length) {
    const have = lowerSet(next.denyPatterns);
    const added = lock.denyPatterns.filter((p) => !have.has(p.trim().toLowerCase()));
    if (added.length) {
      next.denyPatterns = [...next.denyPatterns, ...added];
      changes.push(`${added.length} deny pattern(s) added by the lock`);
    }
  }

  if (lock.requireIsolation && next.isolation === 'none-accepted') {
    next.isolation = 'none';
    changes.push('isolation "none-accepted" treated as "none" (the lock requires real isolation for unattended runs)');
  }
  if (lock.passEnv && next.passEnv) {
    // Not `intersect`: an empty operator list here means "nothing extra", the tightest setting.
    const allowed = lowerSet(lock.passEnv);
    const kept = next.passEnv.filter((v) => allowed.has(v.trim().toLowerCase()));
    if (kept.length !== next.passEnv.length) {
      changes.push(`passEnv narrowed from ${next.passEnv.length} to ${kept.length} variable(s) by the lock`);
      next.passEnv = kept;
    }
  }

  return { policy: next, outcome: { applied: true, changes, maxMode: lock.maxMode } };
}

/**
 * Reads `policy.lock.json` from a directory, or null when there is none.
 *
 * A file that is present but malformed is an error and not a shrug: a deployment that meant to
 * lock something down and mistyped it must not silently run unlocked, because the one thing worse
 * than no lock is a lock everybody believes in.
 */
export async function readPolicyLock(baseDir: string): Promise<PolicyLock | null> {
  return await readPolicyLockAt(join(baseDir, POLICY_LOCK_FILE));
}

/**
 * Where a machine-wide lock lives: `%ProgramData%\copilot-operator\policy.lock.json`, a folder an
 * administrator can protect and the operator cannot edit. A lock beside the install (the form
 * this started with) is honoured too, but the install folder is the operator's own, so a company
 * that means "not on this machine" puts the file here. Null where there is no ProgramData.
 */
export function machineLockPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.ProgramData ?? env.PROGRAMDATA;
  return base ? join(base, 'copilot-operator', POLICY_LOCK_FILE) : null;
}

/** Every lock that applies: the machine-wide one, then the install's own. Each is malformed-fatal. */
export async function readPolicyLocks(baseDir: string, env: NodeJS.ProcessEnv = process.env): Promise<PolicyLock[]> {
  const out: PolicyLock[] = [];
  const machine = machineLockPath(env);
  if (machine) {
    const lock = await readPolicyLockAt(machine);
    if (lock) out.push(lock);
  }
  const local = await readPolicyLock(baseDir);
  if (local) out.push(local);
  return out;
}

/**
 * A policy lock that is there and cannot be used: it is not JSON, or not a lock.
 *
 * Its own class for the reason `SettingsUnusableError` has one (see `api/settings.ts`). Every
 * configuration passes through `resolveConfig`, which reads the locks, so every request that reads
 * the settings meets a broken one, not only the saves; as a plain error it was "Internal server
 * error" wherever a route did not wrap its errors — the System page, the Defaults page, the Project
 * page and the model picker among them, the pages the operator opens to find out what is wrong. The
 * server answers this one the same way on every route, with this message (see `server.ts`).
 */
export class PolicyLockUnusableError extends Error {
  constructor(
    readonly path: string,
    /** What is wrong, said of the file: "is not valid JSON: …". */
    readonly problem: string,
  ) {
    // The way out goes in the same message, as it does for the settings file. Unlike that file,
    // this one is not the operator's to delete in passing: it is somebody's decision about this
    // machine, and the one thing a broken lock must not do is read as no lock at all.
    super(
      `${path} ${problem}\nNothing that reads the settings runs until it is mended: a policy lock that cannot be read as one ` +
        'is never taken for no lock. Whoever administers this machine placed it; mend it there, or remove it if no lock was meant.',
    );
    this.name = 'PolicyLockUnusableError';
  }
}

async function readPolicyLockAt(path: string): Promise<PolicyLock | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (e) {
    throw new PolicyLockUnusableError(path, `is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = PolicyLockSchema.safeParse(value);
  if (!parsed.success) {
    throw new PolicyLockUnusableError(path, `is not a valid policy lock:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}
