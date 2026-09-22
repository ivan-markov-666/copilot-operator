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

export const POLICY_LOCK_FILE = 'policy.lock.json';

export const PolicyLockSchema = z
  .object({
    maxMode: z.enum(['confirm', 'unattended']).optional(),
    allowedPrograms: z.array(z.string()).optional(),
    denyPatterns: z.array(z.string()).optional(),
  })
  .strict();

export type PolicyLock = z.infer<typeof PolicyLockSchema>;

/** The parts of `execution` a lock governs. */
export type LockablePolicy = {
  mode: 'confirm' | 'unattended';
  allowedPrograms: string[];
  denyPatterns: string[];
};

/** What the lock changed, so the run log and the manifest can say it rather than imply it. */
export type LockOutcome = { applied: boolean; changes: string[] };

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

  return { policy: next, outcome: { applied: true, changes } };
}

/**
 * Reads `policy.lock.json` from a directory, or null when there is none.
 *
 * A file that is present but malformed is an error and not a shrug: a deployment that meant to
 * lock something down and mistyped it must not silently run unlocked, because the one thing worse
 * than no lock is a lock everybody believes in.
 */
export async function readPolicyLock(baseDir: string): Promise<PolicyLock | null> {
  const path = join(baseDir, POLICY_LOCK_FILE);
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
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = PolicyLockSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${path} is not a valid policy lock:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}
